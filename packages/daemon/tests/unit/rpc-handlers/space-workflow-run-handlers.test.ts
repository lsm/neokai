/**
 * Tests for Space Workflow Run RPC Handlers
 *
 * Covers:
 * - spaceWorkflowRun.start: throws if spaceId missing, title missing, space not found,
 *   workflowId not found, no workflows exist; creates run and emits event
 * - spaceWorkflowRun.list: throws if spaceId missing, space not found; returns runs filtered by status
 * - spaceWorkflowRun.get: throws if id missing, not found; returns run; ownership check
 * - spaceWorkflowRun.cancel: throws if id missing, not found; no-op if already cancelled;
 *   throws if completed; cancels pending/in_progress tasks; emits event
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { Space, SpaceWorkflow, SpaceWorkflowRun, SpaceTask } from '@neokai/shared';
import {
	setupSpaceWorkflowRunHandlers,
	type SpaceWorkflowRunTaskManagerFactory,
} from '../../../src/lib/rpc-handlers/space-workflow-run-handlers.ts';
import type { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import type { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import type { SpaceRuntimeService } from '../../../src/lib/space/runtime/space-runtime-service.ts';
import type { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import type { DaemonHub } from '../../../src/lib/daemon-hub.ts';

type RequestHandler = (data: unknown) => Promise<unknown>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.now();

const mockSpace: Space = {
	id: 'space-1',
	workspacePath: '/tmp/test-workspace',
	name: 'Test Space',
	description: '',
	backgroundContext: '',
	instructions: '',
	sessionIds: [],
	status: 'active',
	createdAt: NOW,
	updatedAt: NOW,
};

const mockWorkflow: SpaceWorkflow = {
	id: 'workflow-1',
	spaceId: 'space-1',
	name: 'Test Workflow',
	steps: [{ id: 'step-1', name: 'Step One', agentId: 'agent-1' }],
	transitions: [],
	startStepId: 'step-1',
	rules: [],
	tags: [],
	createdAt: NOW,
	updatedAt: NOW,
};

const mockRun: SpaceWorkflowRun = {
	id: 'run-1',
	spaceId: 'space-1',
	workflowId: 'workflow-1',
	title: 'Test Run',
	currentStepId: 'step-1',
	status: 'in_progress',
	createdAt: NOW,
	updatedAt: NOW,
};

const mockTask: SpaceTask = {
	id: 'task-1',
	spaceId: 'space-1',
	title: 'Step One',
	description: '',
	status: 'pending',
	priority: 'normal',
	workflowRunId: 'run-1',
	workflowStepId: 'step-1',
	dependsOn: [],
	createdAt: NOW,
	updatedAt: NOW,
};

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;
	return { hub, handlers };
}

function createMockDaemonHub(): DaemonHub {
	return {
		emit: mock(async () => {}),
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
}

function createMockSpaceManager(space: Space | null = mockSpace): SpaceManager {
	return {
		getSpace: mock(async () => space),
	} as unknown as SpaceManager;
}

function createMockWorkflowManager(
	workflows: SpaceWorkflow[] = [mockWorkflow],
	singleWorkflow: SpaceWorkflow | null = mockWorkflow
): SpaceWorkflowManager {
	return {
		listWorkflows: mock(() => workflows),
		getWorkflow: mock(() => singleWorkflow),
	} as unknown as SpaceWorkflowManager;
}

function createMockRunRepo(
	run: SpaceWorkflowRun | null = mockRun,
	runs: SpaceWorkflowRun[] = [mockRun]
): SpaceWorkflowRunRepository {
	return {
		getRun: mock(() => run),
		listBySpace: mock(() => runs),
		updateStatus: mock((id: string, status: string) =>
			run ? { ...run, id, status: status as SpaceWorkflowRun['status'] } : null
		),
	} as unknown as SpaceWorkflowRunRepository;
}

function createMockRuntime(run: SpaceWorkflowRun = mockRun): SpaceRuntime {
	return {
		startWorkflowRun: mock(async () => ({ run, tasks: [mockTask] })),
		start: mock(() => {}),
		stop: mock(() => {}),
		executeTick: mock(async () => {}),
	} as unknown as SpaceRuntime;
}

function createMockRuntimeService(
	space: Space | null = mockSpace,
	runtime: SpaceRuntime = createMockRuntime()
): SpaceRuntimeService {
	return {
		createOrGetRuntime: mock(async (spaceId: string) => {
			if (!space) throw new Error(`Space not found: ${spaceId}`);
			return runtime;
		}),
		start: mock(() => {}),
		stop: mock(() => {}),
		stopRuntime: mock(() => {}),
	} as unknown as SpaceRuntimeService;
}

function createMockTaskManager(tasks: SpaceTask[] = []): SpaceTaskManager {
	return {
		listTasksByWorkflowRun: mock(async () => tasks),
		cancelTask: mock(async (taskId: string) => ({
			...mockTask,
			id: taskId,
			status: 'cancelled' as const,
		})),
	} as unknown as SpaceTaskManager;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('space-workflow-run-handlers', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;
	let daemonHub: DaemonHub;
	let spaceManager: SpaceManager;
	let workflowManager: SpaceWorkflowManager;
	let runRepo: SpaceWorkflowRunRepository;
	let runtimeService: SpaceRuntimeService;
	let runtime: SpaceRuntime;
	let taskManagerFactory: SpaceWorkflowRunTaskManagerFactory;
	let taskManager: SpaceTaskManager;

	function setup(
		opts: {
			space?: Space | null;
			workflows?: SpaceWorkflow[];
			singleWorkflow?: SpaceWorkflow | null;
			run?: SpaceWorkflowRun | null;
			runs?: SpaceWorkflowRun[];
			tasks?: SpaceTask[];
		} = {}
	) {
		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;
		daemonHub = createMockDaemonHub();
		// Use undefined check (not nullish coalescing) so null is preserved
		const resolvedSpace = 'space' in opts ? opts.space : mockSpace;
		spaceManager = createMockSpaceManager(resolvedSpace ?? null);
		workflowManager = createMockWorkflowManager(
			opts.workflows ?? [mockWorkflow],
			opts.singleWorkflow !== undefined ? opts.singleWorkflow : mockWorkflow
		);
		const resolvedRun = 'run' in opts ? opts.run : mockRun;
		runRepo = createMockRunRepo(resolvedRun ?? null, opts.runs ?? [mockRun]);
		runtime = createMockRuntime(resolvedRun ?? mockRun);
		runtimeService = createMockRuntimeService(resolvedSpace ?? null, runtime);
		taskManager = createMockTaskManager(opts.tasks ?? []);
		taskManagerFactory = mock(() => taskManager);

		setupSpaceWorkflowRunHandlers(
			hub,
			spaceManager,
			workflowManager,
			runRepo,
			runtimeService,
			taskManagerFactory,
			daemonHub
		);
	}

	const call = (method: string, data: unknown) => {
		const handler = handlers.get(method);
		if (!handler) throw new Error(`No handler registered for ${method}`);
		return handler(data);
	};

	beforeEach(() => setup());

	// ─── spaceWorkflowRun.start ──────────────────────────────────────────────

	describe('spaceWorkflowRun.start', () => {
		it('throws if spaceId is missing', async () => {
			await expect(call('spaceWorkflowRun.start', { title: 'My Run' })).rejects.toThrow(
				'spaceId is required'
			);
		});

		it('throws if title is missing', async () => {
			await expect(call('spaceWorkflowRun.start', { spaceId: 'space-1' })).rejects.toThrow(
				'title is required'
			);
		});

		it('throws if title is empty string', async () => {
			await expect(
				call('spaceWorkflowRun.start', { spaceId: 'space-1', title: '   ' })
			).rejects.toThrow('title is required');
		});

		it('throws if space not found', async () => {
			setup({ space: null });
			await expect(
				call('spaceWorkflowRun.start', { spaceId: 'missing', title: 'Test' })
			).rejects.toThrow('Space not found: missing');
		});

		it('throws if provided workflowId not found', async () => {
			setup({ singleWorkflow: null });
			await expect(
				call('spaceWorkflowRun.start', {
					spaceId: 'space-1',
					title: 'Test',
					workflowId: 'bad-wf',
				})
			).rejects.toThrow('Workflow not found: bad-wf');
		});

		it('throws if provided workflowId belongs to a different space', async () => {
			const otherWorkflow: SpaceWorkflow = {
				...mockWorkflow,
				id: 'wf-other',
				spaceId: 'space-99',
			};
			setup({ singleWorkflow: otherWorkflow });
			await expect(
				call('spaceWorkflowRun.start', {
					spaceId: 'space-1',
					title: 'Test',
					workflowId: 'wf-other',
				})
			).rejects.toThrow('Workflow not found: wf-other');
		});

		it('throws if no workflows exist (auto-select mode)', async () => {
			setup({ workflows: [], singleWorkflow: null });
			await expect(
				call('spaceWorkflowRun.start', { spaceId: 'space-1', title: 'Test' })
			).rejects.toThrow('No workflows found for space: space-1');
		});

		it('creates run via runtime and emits space.workflowRun.created', async () => {
			const result = await call('spaceWorkflowRun.start', {
				spaceId: 'space-1',
				title: 'My Run',
				description: 'Some context',
			});

			expect(result).toEqual({ run: mockRun });
			expect(runtime.startWorkflowRun).toHaveBeenCalledWith(
				'space-1',
				'workflow-1',
				'My Run',
				'Some context',
				undefined
			);
			expect(daemonHub.emit).toHaveBeenCalledWith('space.workflowRun.created', {
				sessionId: 'global',
				spaceId: 'space-1',
				runId: mockRun.id,
				run: mockRun,
			});
		});

		it('auto-selects first workflow when workflowId not provided', async () => {
			await call('spaceWorkflowRun.start', { spaceId: 'space-1', title: 'Auto' });
			expect(runtime.startWorkflowRun).toHaveBeenCalledWith(
				'space-1',
				'workflow-1',
				'Auto',
				undefined,
				undefined
			);
		});

		it('uses provided workflowId when given', async () => {
			await call('spaceWorkflowRun.start', {
				spaceId: 'space-1',
				title: 'Explicit WF',
				workflowId: 'workflow-1',
			});
			expect(runtime.startWorkflowRun).toHaveBeenCalledWith(
				'space-1',
				'workflow-1',
				'Explicit WF',
				undefined,
				undefined
			);
		});

		it('passes goalId through to startWorkflowRun', async () => {
			await call('spaceWorkflowRun.start', {
				spaceId: 'space-1',
				title: 'Goal Run',
				goalId: 'goal-rpc-123',
			});
			expect(runtime.startWorkflowRun).toHaveBeenCalledWith(
				'space-1',
				'workflow-1',
				'Goal Run',
				undefined,
				'goal-rpc-123'
			);
		});
	});

	// ─── spaceWorkflowRun.list ───────────────────────────────────────────────

	describe('spaceWorkflowRun.list', () => {
		it('throws if spaceId is missing', async () => {
			await expect(call('spaceWorkflowRun.list', {})).rejects.toThrow('spaceId is required');
		});

		it('throws if space not found', async () => {
			setup({ space: null });
			await expect(call('spaceWorkflowRun.list', { spaceId: 'missing' })).rejects.toThrow(
				'Space not found: missing'
			);
		});

		it('returns all runs for the space', async () => {
			const result = await call('spaceWorkflowRun.list', { spaceId: 'space-1' });
			expect(result).toEqual({ runs: [mockRun] });
		});

		it('filters runs by status when provided', async () => {
			const completedRun: SpaceWorkflowRun = { ...mockRun, id: 'run-2', status: 'completed' };
			setup({ runs: [mockRun, completedRun] });

			const result = (await call('spaceWorkflowRun.list', {
				spaceId: 'space-1',
				status: 'in_progress',
			})) as { runs: SpaceWorkflowRun[] };

			expect(result.runs).toHaveLength(1);
			expect(result.runs[0].id).toBe('run-1');
		});

		it('returns empty list when no runs match status filter', async () => {
			const result = (await call('spaceWorkflowRun.list', {
				spaceId: 'space-1',
				status: 'cancelled',
			})) as { runs: SpaceWorkflowRun[] };

			expect(result.runs).toHaveLength(0);
		});
	});

	// ─── spaceWorkflowRun.get ────────────────────────────────────────────────

	describe('spaceWorkflowRun.get', () => {
		it('throws if id is missing', async () => {
			await expect(call('spaceWorkflowRun.get', {})).rejects.toThrow('id is required');
		});

		it('throws if run not found', async () => {
			setup({ run: null });
			await expect(call('spaceWorkflowRun.get', { id: 'missing-run' })).rejects.toThrow(
				'WorkflowRun not found: missing-run'
			);
		});

		it('returns the run', async () => {
			const result = await call('spaceWorkflowRun.get', { id: 'run-1' });
			expect(result).toEqual({ run: mockRun });
		});

		it('returns the run without spaceId filter', async () => {
			const result = await call('spaceWorkflowRun.get', { id: 'run-1' });
			expect(result).toEqual({ run: mockRun });
		});

		it('throws if spaceId does not match run.spaceId (ownership check)', async () => {
			await expect(
				call('spaceWorkflowRun.get', { id: 'run-1', spaceId: 'space-other' })
			).rejects.toThrow('WorkflowRun not found: run-1');
		});

		it('succeeds when spaceId matches run.spaceId', async () => {
			const result = await call('spaceWorkflowRun.get', { id: 'run-1', spaceId: 'space-1' });
			expect(result).toEqual({ run: mockRun });
		});
	});

	// ─── spaceWorkflowRun.cancel ─────────────────────────────────────────────

	describe('spaceWorkflowRun.cancel', () => {
		it('throws if id is missing', async () => {
			await expect(call('spaceWorkflowRun.cancel', {})).rejects.toThrow('id is required');
		});

		it('throws if run not found', async () => {
			setup({ run: null });
			await expect(call('spaceWorkflowRun.cancel', { id: 'missing-run' })).rejects.toThrow(
				'WorkflowRun not found: missing-run'
			);
		});

		it('returns success immediately if already cancelled', async () => {
			const cancelledRun: SpaceWorkflowRun = { ...mockRun, status: 'cancelled' };
			setup({ run: cancelledRun });

			const result = await call('spaceWorkflowRun.cancel', { id: 'run-1' });
			expect(result).toEqual({ success: true });
			// Should not attempt to update status or cancel tasks
			expect(runRepo.updateStatus).not.toHaveBeenCalled();
		});

		it('throws if trying to cancel a completed run', async () => {
			const completedRun: SpaceWorkflowRun = { ...mockRun, status: 'completed' };
			setup({ run: completedRun });

			await expect(call('spaceWorkflowRun.cancel', { id: 'run-1' })).rejects.toThrow(
				'Cannot cancel a completed workflow run'
			);
		});

		it('cancels the run and emits space.workflowRun.updated (no tasks)', async () => {
			setup({ tasks: [] });

			const result = await call('spaceWorkflowRun.cancel', { id: 'run-1' });
			expect(result).toEqual({ success: true });

			expect(runRepo.updateStatus).toHaveBeenCalledWith('run-1', 'cancelled');
			expect(daemonHub.emit).toHaveBeenCalledWith('space.workflowRun.updated', {
				sessionId: 'global',
				spaceId: 'space-1',
				runId: 'run-1',
				run: expect.objectContaining({ status: 'cancelled' }),
			});
		});

		it('cancels pending and in_progress tasks before cancelling the run', async () => {
			const inProgressTask: SpaceTask = {
				...mockTask,
				id: 'task-2',
				status: 'in_progress',
			};
			const completedTask: SpaceTask = {
				...mockTask,
				id: 'task-3',
				status: 'completed',
			};
			setup({ tasks: [mockTask, inProgressTask, completedTask] });

			await call('spaceWorkflowRun.cancel', { id: 'run-1' });

			// Factory should have been called with the run's spaceId
			expect(taskManagerFactory).toHaveBeenCalledWith('space-1');

			// cancelTask should be called for pending and in_progress but not completed
			expect(taskManager.cancelTask).toHaveBeenCalledTimes(2);
			expect(taskManager.cancelTask).toHaveBeenCalledWith('task-1');
			expect(taskManager.cancelTask).toHaveBeenCalledWith('task-2');
			// completed task should not be cancelled
			const callArgs = (taskManager.cancelTask as ReturnType<typeof mock>).mock.calls.map(
				(c) => c[0]
			);
			expect(callArgs).not.toContain('task-3');

			// Run should also be cancelled
			expect(runRepo.updateStatus).toHaveBeenCalledWith('run-1', 'cancelled');
		});

		it('continues cancelling remaining tasks even if one cancelTask fails', async () => {
			const task2: SpaceTask = { ...mockTask, id: 'task-2', status: 'pending' };
			setup({ tasks: [mockTask, task2] });

			// Make the first cancelTask fail
			let callCount = 0;
			taskManager = {
				listTasksByWorkflowRun: mock(async () => [mockTask, task2]),
				cancelTask: mock(async (taskId: string) => {
					callCount++;
					if (callCount === 1) throw new Error('cancel failed');
					return { ...mockTask, id: taskId, status: 'cancelled' as const };
				}),
			} as unknown as SpaceTaskManager;
			taskManagerFactory = mock(() => taskManager);

			// Re-setup with new mocks
			const mh = createMockMessageHub();
			hub = mh.hub;
			handlers = mh.handlers;
			daemonHub = createMockDaemonHub();
			spaceManager = createMockSpaceManager();
			workflowManager = createMockWorkflowManager();
			runRepo = createMockRunRepo();

			setupSpaceWorkflowRunHandlers(
				hub,
				spaceManager,
				workflowManager,
				runRepo,
				createMockRuntimeService(),
				taskManagerFactory,
				daemonHub
			);

			// Should not throw even though one cancelTask failed
			const result = await call('spaceWorkflowRun.cancel', { id: 'run-1' });
			expect(result).toEqual({ success: true });

			// Both tasks were attempted
			expect(taskManager.cancelTask).toHaveBeenCalledTimes(2);
			// Run still gets cancelled
			expect(runRepo.updateStatus).toHaveBeenCalledWith('run-1', 'cancelled');
		});
	});
});
