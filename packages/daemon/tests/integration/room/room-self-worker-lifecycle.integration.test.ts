import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, Room } from '@neokai/shared';
import { Database } from '../../../src/storage/database';
import { createDaemonHub, type DaemonHub } from '../../../src/lib/daemon-hub';
import { RoomManager } from '../../../src/lib/room/room-manager';
import { RoomSelfService, type RoomSelfContext } from '../../../src/lib/room/room-self-service';
import { RoomSelfLifecycleManager } from '../../../src/lib/room/room-self-lifecycle-manager';
import { WorkerManager } from '../../../src/lib/room/worker-manager';
import { TaskManager } from '../../../src/lib/room/task-manager';
import { RoomSelfStateRepository } from '../../../src/storage/repositories/room-self-state-repository';
import type { SessionLifecycle } from '../../../src/lib/session/session-lifecycle';
import type { RecurringJobScheduler } from '../../../src/lib/room/recurring-job-scheduler';
import type { PromptTemplateManager } from '../../../src/lib/prompts/prompt-template-manager';

interface Fixture {
	db: Database;
	daemonHub: DaemonHub;
	roomManager: RoomManager;
	room: Room;
	ctx: RoomSelfContext;
	taskManager: TaskManager;
	workerManager: WorkerManager;
	workerMessageEnqueueMock: ReturnType<typeof mock>;
	service: RoomSelfService;
	stateRepo: RoomSelfStateRepository;
	cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
	const db = new Database(':memory:');
	await db.initialize();
	const rawDb = db.getDatabase();
	try {
		rawDb.exec(`ALTER TABLE rooms ADD COLUMN allowed_models TEXT DEFAULT '[]'`);
	} catch {
		// Column already exists.
	}

	const daemonHub = createDaemonHub('room-self-lifecycle-test');
	await daemonHub.initialize();

	const roomManager = new RoomManager(rawDb);
	const room = roomManager.createRoom({
		name: 'Integration Room',
		allowedPaths: [{ path: '/tmp' }],
		defaultPath: '/tmp',
	});

	let workerCounter = 0;
	const workerMessageEnqueueMock = mock(async () => {});
	const workerAgentSession = {
		session: { config: {} as Record<string, unknown> },
		startStreamingQuery: mock(async () => {}),
		messageQueue: { enqueue: workerMessageEnqueueMock },
		cleanup: mock(async () => {}),
	};

	const sessionLifecycle = {
		create: mock(async () => {
			workerCounter += 1;
			const workerSessionId = `worker-session-${workerCounter}`;
			const timestamp = new Date().toISOString();
			rawDb
				.prepare(
					`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					workerSessionId,
					`Worker ${workerCounter}`,
					room.defaultPath ?? '/tmp',
					timestamp,
					timestamp,
					'active',
					'{}',
					'{}',
					'worker'
				);
			return workerSessionId;
		}),
		getAgentSession: mock(() => workerAgentSession),
	} as unknown as SessionLifecycle;

	const workerManager = new WorkerManager(db, daemonHub, sessionLifecycle, roomManager);
	const taskManager = new TaskManager(rawDb, room.id);
	const stateRepo = new RoomSelfStateRepository(rawDb);

	const messageHub = {
		event: mock(() => {}),
		request: mock(async () => ({})),
	} as unknown as MessageHub;

	const recurringJobScheduler = {} as unknown as RecurringJobScheduler;
	const promptTemplateManager = {} as unknown as PromptTemplateManager;

	const ctx: RoomSelfContext = {
		room,
		db,
		daemonHub,
		messageHub,
		roomManager,
		workerManager,
		getApiKey: async () => null,
		promptTemplateManager,
		recurringJobScheduler,
		workspaceRoot: '/tmp',
	};

	const service = new RoomSelfService(ctx, {
		maxConcurrentPairs: 2,
		idleCheckIntervalMs: 60_000,
		maxErrorCount: 5,
		autoRetryTasks: true,
	});

	// Worker sessions reference room_session_id -> sessions(id), so provide room:self session row.
	const now = new Date().toISOString();
	rawDb
		.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			service.sessionId,
			`Room Self ${room.name}`,
			room.defaultPath ?? '/tmp',
			now,
			now,
			'active',
			'{}',
			'{}',
			'room_self'
		);

	const lifecycleManager = new RoomSelfLifecycleManager(room.id, db, daemonHub);
	(service as unknown as { lifecycleManager: RoomSelfLifecycleManager }).lifecycleManager =
		lifecycleManager;
	(service as unknown as { state: unknown }).state = lifecycleManager.initialize();
	(service as unknown as { subscribeToEvents: () => void }).subscribeToEvents();

	return {
		db,
		daemonHub,
		roomManager,
		room,
		ctx,
		taskManager,
		workerManager,
		workerMessageEnqueueMock,
		service,
		stateRepo,
		cleanup: async () => {
			try {
				await service.stop();
			} catch {
				// No-op for cleanup safety in partially-initialized tests.
			}
			db.close();
		},
	};
}

describe('RoomSelf worker lifecycle integration', () => {
	let fixture: Fixture;

	beforeEach(async () => {
		fixture = await createFixture();
	});

	afterEach(async () => {
		if (fixture) {
			await fixture.cleanup();
		}
	});

	test('spawn -> progress -> completion updates task and room-self lifecycle', async () => {
		await fixture.service.forceState('executing');

		const task = await fixture.taskManager.createTask({
			title: 'Implement integration flow',
			description: 'Verify worker lifecycle end-to-end',
			priority: 'normal',
		});

		const workerSessionId = await (
			fixture.service as unknown as {
				spawnWorkerForTask: (
					taskArg: typeof task,
					options: { throwOnBlocked: boolean }
				) => Promise<string | null>;
			}
		).spawnWorkerForTask(task, { throwOnBlocked: true });

		expect(workerSessionId).toBeString();
		expect(fixture.service.getState().activeWorkerSessionIds).toContain(workerSessionId!);

		const startedTask = await fixture.taskManager.getTask(task.id);
		expect(startedTask?.status).toBe('in_progress');
		expect(startedTask?.sessionId).toBe(workerSessionId);

		const workerToolsServer = fixture.workerManager.getWorkerTools(workerSessionId!);
		expect(workerToolsServer).toBeDefined();
		const tools = (
			workerToolsServer as unknown as {
				instance: {
					_registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
				};
			}
		).instance._registeredTools;

		await tools.worker_report_progress.handler({
			progress: 60,
			current_step: 'Applying patch',
			details: 'Updated service lifecycle handling',
		});

		const progressedTask = await fixture.taskManager.getTask(task.id);
		expect(progressedTask?.status).toBe('in_progress');
		expect(progressedTask?.progress).toBe(60);
		expect(progressedTask?.currentStep).toBe('Applying patch');

		await tools.worker_complete_task.handler({
			summary: 'Completed integration flow updates',
			files_changed: ['src/lib/room/room-self-service.ts'],
		});

		const completedTask = await fixture.taskManager.getTask(task.id);
		expect(completedTask?.status).toBe('completed');
		expect(completedTask?.progress).toBe(100);
		expect(fixture.service.getState().activeWorkerSessionIds).toEqual([]);
		expect(fixture.service.getState().lifecycleState).toBe('idle');
		expect(fixture.workerManager.getWorkerTools(workerSessionId!)).toBeUndefined();
	});

	test('worker failure clears active session and fails task', async () => {
		await fixture.service.forceState('executing');

		const task = await fixture.taskManager.createTask({
			title: 'Trigger failure path',
			description: 'Ensure worker failure propagates correctly',
			priority: 'normal',
		});

		const workerSessionId = await (
			fixture.service as unknown as {
				spawnWorkerForTask: (
					taskArg: typeof task,
					options: { throwOnBlocked: boolean }
				) => Promise<string | null>;
			}
		).spawnWorkerForTask(task, { throwOnBlocked: true });

		expect(workerSessionId).toBeString();
		await fixture.workerManager.markWorkerFailed(workerSessionId!, 'Test worker crash');

		const failedTask = await fixture.taskManager.getTask(task.id);
		expect(failedTask?.status).toBe('failed');
		expect(failedTask?.error).toBe('Test worker crash');
		expect(fixture.service.getState().activeWorkerSessionIds).toEqual([]);
		expect(fixture.service.getState().lifecycleState).toBe('idle');
		expect(fixture.roomManager.getRoom(fixture.room.id)?.sessionIds).not.toContain(
			workerSessionId!
		);
	});

	test('review response in agent-session path resumes the waiting worker deterministically', async () => {
		await fixture.service.forceState('executing');
		const roomAgentQueueEnqueueMock = mock(async () => {});
		(
			fixture.service as unknown as {
				agentSession: {
					messageQueue: { enqueue: (message: string, highPriority: boolean) => Promise<void> };
				};
			}
		).agentSession = {
			messageQueue: {
				enqueue: roomAgentQueueEnqueueMock,
			},
		};

		const task = await fixture.taskManager.createTask({
			title: 'Needs review to continue',
			description: 'Pause and wait for approval',
			priority: 'normal',
		});
		const workerSessionId = await (
			fixture.service as unknown as {
				spawnWorkerForTask: (
					taskArg: typeof task,
					options: { throwOnBlocked: boolean }
				) => Promise<string | null>;
			}
		).spawnWorkerForTask(task, { throwOnBlocked: true });
		expect(workerSessionId).toBeString();

		const workerToolsServer = fixture.workerManager.getWorkerTools(workerSessionId!);
		expect(workerToolsServer).toBeDefined();
		const tools = (
			workerToolsServer as unknown as {
				instance: {
					_registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
				};
			}
		).instance._registeredTools;

		await tools.worker_request_review.handler({
			reason: 'Need explicit sign-off before proceeding',
		});

		expect(fixture.service.getState().lifecycleState).toBe('waiting');
		expect(fixture.stateRepo.getWaitingContext(fixture.room.id)).toEqual(
			expect.objectContaining({
				type: 'review',
				taskId: task.id,
				workerSessionId: workerSessionId!,
			})
		);
		expect(fixture.workerManager.getWorkerBySessionId(workerSessionId!)?.status).toBe(
			'waiting_for_review'
		);

		await fixture.service.handleHumanInput({
			type: 'review_response',
			taskId: task.id,
			approved: true,
			response: 'Looks good, continue',
		});

		const reviewResumeCall = fixture.workerMessageEnqueueMock.mock.calls.find(
			([message]) =>
				typeof message === 'string' &&
				message.includes(`Human review decision for task ${task.id}: APPROVED`)
		);
		expect(reviewResumeCall).toBeDefined();
		expect(reviewResumeCall?.[1]).toBe(true);
		expect(fixture.workerManager.getWorkerBySessionId(workerSessionId!)?.status).toBe('running');
		expect(fixture.stateRepo.getWaitingContext(fixture.room.id)).toBeNull();
		expect(fixture.service.getState().lifecycleState).toBe('planning');
		expect(roomAgentQueueEnqueueMock).toHaveBeenCalledWith(
			`Worker review resolved for task ${task.id}: APPROVED`,
			true
		);
	});

	test('setWaiting throws and clears context when lifecycle cannot transition to waiting', async () => {
		await fixture.service.forceState('paused');

		await expect(
			fixture.service.setWaiting({
				type: 'question',
				taskId: 'task-paused',
				questionId: 'q-paused',
				reason: 'Should fail while paused',
				since: Date.now(),
			})
		).rejects.toThrow('Failed to enter waiting state');

		expect(fixture.service.getState().lifecycleState).toBe('paused');
		expect(fixture.stateRepo.getWaitingContext(fixture.room.id)).toBeNull();
	});

	test('agent-session human input rejects non-message responses when not waiting', async () => {
		(
			fixture.service as unknown as {
				agentSession: {
					messageQueue: { enqueue: (message: string, highPriority: boolean) => Promise<void> };
				};
			}
		).agentSession = {
			messageQueue: {
				enqueue: mock(async () => {}),
			},
		};

		await fixture.service.forceState('planning');

		await expect(
			fixture.service.handleHumanInput({
				type: 'escalation_response',
				escalationId: 'esc-not-waiting',
				response: 'Proceed',
			})
		).rejects.toThrow('not waiting for human input');
	});

	test('agent-session escalation response rejects stale escalation IDs and keeps waiting context', async () => {
		(
			fixture.service as unknown as {
				agentSession: {
					messageQueue: { enqueue: (message: string, highPriority: boolean) => Promise<void> };
				};
			}
		).agentSession = {
			messageQueue: {
				enqueue: mock(async () => {}),
			},
		};

		await fixture.service.forceState('executing');
		await fixture.service.setWaiting({
			type: 'escalation',
			taskId: 'task-esc',
			escalationId: 'esc-expected',
			reason: 'Need human escalation response',
			since: Date.now(),
		});

		await expect(
			fixture.service.handleHumanInput({
				type: 'escalation_response',
				escalationId: 'esc-stale',
				response: 'Resolve',
			})
		).rejects.toThrow('unknown/stale escalation');

		expect(fixture.service.getState().lifecycleState).toBe('waiting');
		expect(fixture.stateRepo.getWaitingContext(fixture.room.id)?.escalationId).toBe('esc-expected');
	});

	test('waiting context persists and supports human-input resume after restart', async () => {
		const questionId = 'question-restart-1';
		await fixture.service.forceState('executing');
		await fixture.service.setWaiting({
			type: 'question',
			taskId: 'task-restart',
			questionId,
			reason: 'Need operator input',
			since: Date.now(),
		});

		expect(fixture.service.getState().lifecycleState).toBe('waiting');
		expect(fixture.stateRepo.getWaitingContext(fixture.room.id)?.questionId).toBe(questionId);

		const resumedService = new RoomSelfService(
			{
				...fixture.ctx,
			},
			{
				maxConcurrentPairs: 2,
				idleCheckIntervalMs: 60_000,
				maxErrorCount: 5,
				autoRetryTasks: true,
			}
		);

		const resumedLifecycleManager = new RoomSelfLifecycleManager(
			fixture.room.id,
			fixture.db,
			fixture.daemonHub
		);
		(
			resumedService as unknown as {
				lifecycleManager: RoomSelfLifecycleManager;
				state: unknown;
				waitingContext: unknown;
			}
		).lifecycleManager = resumedLifecycleManager;
		(resumedService as unknown as { state: unknown }).state = resumedLifecycleManager.initialize();
		(resumedService as unknown as { waitingContext: unknown }).waitingContext =
			fixture.stateRepo.getWaitingContext(fixture.room.id);

		const answeredEvents: Array<{
			questionId: string;
			responses: Record<string, string | string[]>;
		}> = [];
		const unsub = fixture.daemonHub.on('roomAgent.questionAnswered', (event) => {
			answeredEvents.push({
				questionId: event.questionId,
				responses: event.responses,
			});
		});

		await resumedService.handleHumanInput({
			type: 'question_response',
			questionId,
			responses: {
				approval: 'approved',
			},
		});

		expect(answeredEvents).toHaveLength(1);
		expect(answeredEvents[0]).toEqual({
			questionId,
			responses: {
				approval: 'approved',
			},
		});
		expect(resumedService.getState().lifecycleState).toBe('planning');
		expect(fixture.stateRepo.getWaitingContext(fixture.room.id)).toBeNull();

		unsub();
		await resumedService.stop().catch(() => {});
	});
});
