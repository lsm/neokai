/**
 * SpaceRuntime — Edge Case and Resilience Tests (Task 6.3)
 *
 * Tests adversarial and failure-mode scenarios to ensure the notification
 * system is robust under adverse conditions:
 *
 *   1. ThrowingNotificationSink — tick loop survives, other runs still processed
 *   2. Rapid status changes between ticks — only final state generates notification
 *   3. Runtime rehydration with workflow tasks in needs_attention → re-notified on first tick
 *   4. Deduplication for standalone tasks across many ticks
 *   5. Workflow run cancelled externally while notification is in flight → no stale event
 *   6. Session not available when notification fires → graceful degradation, no crash
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../src/lib/space/runtime/space-runtime.ts';
import type {
	NotificationSink,
	SpaceNotificationEvent,
} from '../../../src/lib/space/runtime/notification-sink.ts';
import { SessionNotificationSink } from '../../../src/lib/space/runtime/session-notification-sink.ts';
import type { SessionFactory } from '../../../src/lib/room/runtime/task-group-manager.ts';
import type { MessageDeliveryMode } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Mock sinks
// ---------------------------------------------------------------------------

/** Standard recording sink for assertions */
class MockNotificationSink implements NotificationSink {
	readonly events: SpaceNotificationEvent[] = [];

	notify(event: SpaceNotificationEvent): Promise<void> {
		this.events.push(event);
		return Promise.resolve();
	}

	clear(): void {
		this.events.length = 0;
	}
}

/** Sink that always throws — used to verify tick resilience */
class ThrowingNotificationSink implements NotificationSink {
	readonly thrownEvents: SpaceNotificationEvent[] = [];

	notify(event: SpaceNotificationEvent): Promise<void> {
		this.thrownEvents.push(event);
		return Promise.reject(new Error(`ThrowingNotificationSink: ${event.kind}`));
	}
}

/** Sink that throws on the first N calls, then records normally */
class FlakyNotificationSink implements NotificationSink {
	readonly events: SpaceNotificationEvent[] = [];
	private callCount = 0;

	constructor(private readonly throwOnFirstN: number) {}

	notify(event: SpaceNotificationEvent): Promise<void> {
		this.callCount++;
		if (this.callCount <= this.throwOnFirstN) {
			return Promise.reject(new Error(`FlakyNotificationSink: call ${this.callCount} threw`));
		}
		this.events.push(event);
		return Promise.resolve();
	}
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-space-runtime-edge',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/ws'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, Date.now(), Date.now());
}

function setSpaceTaskTimeoutMs(db: BunDatabase, spaceId: string, timeoutMs: number): void {
	db.prepare(`UPDATE spaces SET config = ? WHERE id = ?`).run(
		JSON.stringify({ taskTimeoutMs: timeoutMs }),
		spaceId
	);
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, role: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
     config, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, `Agent ${agentId}`, role, Date.now(), Date.now());
}

function buildLinearWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	steps: Array<{ id: string; name: string; agentId: string }>,
	conditions: Array<{ type: 'always' | 'human' }> = []
) {
	const transitions = steps.slice(0, -1).map((step, i) => ({
		from: step.id,
		to: steps[i + 1].id,
		condition: conditions[i] ?? { type: 'always' as const },
		order: 0,
	}));

	return workflowManager.createWorkflow({
		spaceId,
		name: `Workflow ${Date.now()}-${Math.random()}`,
		description: '',
		steps,
		transitions,
		startStepId: steps[0].id,
		rules: [],
		tags: [],
	});
}

// ---------------------------------------------------------------------------
// Mock SessionFactory for SessionNotificationSink tests
// ---------------------------------------------------------------------------

interface InjectedCall {
	sessionId: string;
	message: string;
	opts?: { deliveryMode?: MessageDeliveryMode };
}

function makeMockSessionFactory(opts?: {
	injectError?: Error;
}): SessionFactory & { calls: InjectedCall[] } {
	const calls: InjectedCall[] = [];
	const injectError = opts?.injectError;

	const factory: SessionFactory & { calls: InjectedCall[] } = {
		calls,
		createAndStartSession: async () => {},
		injectMessage: async (sessionId, message, injectOpts) => {
			if (injectError) throw injectError;
			calls.push({ sessionId, message, opts: injectOpts });
		},
		hasSession: () => true,
		answerQuestion: async () => false,
		createWorktree: async () => null,
		restoreSession: async () => false,
		startSession: async () => false,
		setSessionMcpServers: () => false,
		removeWorktree: async () => false,
	};

	return factory;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('SpaceRuntime — edge cases and resilience', () => {
	let db: BunDatabase;
	let dir: string;

	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let sink: MockNotificationSink;
	let runtime: SpaceRuntime;

	const SPACE_ID = 'space-edge-1';
	const WORKSPACE = '/tmp/edge-ws';
	const AGENT = 'agent-edge-coder';

	function makeRuntime(extraConfig?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
		return new SpaceRuntime({
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			notificationSink: sink,
			...extraConfig,
		});
	}

	beforeEach(() => {
		({ db, dir } = makeDb());

		seedSpaceRow(db, SPACE_ID, WORKSPACE);
		seedAgentRow(db, AGENT, SPACE_ID, 'coder');

		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);

		spaceManager = new SpaceManager(db);
		sink = new MockNotificationSink();
		runtime = makeRuntime();
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	// -------------------------------------------------------------------------
	// 1. ThrowingNotificationSink resilience
	// -------------------------------------------------------------------------

	describe('throwing NotificationSink — tick loop resilience', () => {
		test('tick does not crash when sink.notify() throws', async () => {
			const throwingSink = new ThrowingNotificationSink();
			const rt = makeRuntime({ notificationSink: throwingSink });

			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-throw-1', name: 'Only Step', agentId: AGENT },
			]);
			const { tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Build failed' });

			// Tick must complete without throwing even though the sink throws
			await expect(rt.executeTick()).resolves.toBeUndefined();

			// Sink did attempt to notify
			expect(throwingSink.thrownEvents).toHaveLength(1);
			expect(throwingSink.thrownEvents[0].kind).toBe('task_needs_attention');
		});

		test('tick does not crash when sink.notify() throws for workflow_run_completed', async () => {
			const throwingSink = new ThrowingNotificationSink();
			const rt = makeRuntime({ notificationSink: throwingSink });

			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-throw-done', name: 'Only Step', agentId: AGENT },
			]);
			const { tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await expect(rt.executeTick()).resolves.toBeUndefined();

			expect(throwingSink.thrownEvents).toHaveLength(1);
			expect(throwingSink.thrownEvents[0].kind).toBe('workflow_run_completed');
		});

		test("all runs processed even if one run's notification throws", async () => {
			// Use a flaky sink: first call throws, subsequent calls succeed
			const flakySink = new FlakyNotificationSink(1);
			const rt = makeRuntime({ notificationSink: flakySink });

			// Run A — needs_attention (first notify call → throws)
			const wfA = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-flaky-a', name: 'Step A', agentId: AGENT },
			]);
			const { tasks: tasksA } = await rt.startWorkflowRun(SPACE_ID, wfA.id, 'Run A');
			taskRepo.updateTask(tasksA[0].id, { status: 'needs_attention', error: 'Error A' });

			// Run B — needs_attention (second notify call → succeeds)
			const wfB = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-flaky-b', name: 'Step B', agentId: AGENT },
			]);
			const { tasks: tasksB } = await rt.startWorkflowRun(SPACE_ID, wfB.id, 'Run B');
			taskRepo.updateTask(tasksB[0].id, { status: 'needs_attention', error: 'Error B' });

			// Tick must complete without crashing; run B's notification should succeed
			await expect(rt.executeTick()).resolves.toBeUndefined();

			// The second notification (run B) succeeded and was recorded
			expect(flakySink.events).toHaveLength(1);
			if (flakySink.events[0].kind === 'task_needs_attention') {
				expect(flakySink.events[0].taskId).toBe(tasksB[0].id);
			}
		});

		test('tick does not crash when sink.notify() throws for standalone task', async () => {
			const throwingSink = new ThrowingNotificationSink();
			const rt = makeRuntime({ notificationSink: throwingSink });

			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone',
				description: '',
				status: 'needs_attention',
			});

			await expect(rt.executeTick()).resolves.toBeUndefined();

			expect(throwingSink.thrownEvents).toHaveLength(1);
			expect(throwingSink.thrownEvents[0].kind).toBe('task_needs_attention');
		});

		test('tick does not crash when sink.notify() throws for task_timeout', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);
			const throwingSink = new ThrowingNotificationSink();
			const rt = makeRuntime({ notificationSink: throwingSink });

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Slow Standalone',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 5000,
				task.id
			);

			await expect(rt.executeTick()).resolves.toBeUndefined();

			expect(throwingSink.thrownEvents).toHaveLength(1);
			expect(throwingSink.thrownEvents[0].kind).toBe('task_timeout');
		});
	});

	// -------------------------------------------------------------------------
	// 2. Rapid status changes between ticks
	// -------------------------------------------------------------------------

	describe('rapid status changes between ticks', () => {
		test('task goes needs_attention→pending→in_progress→needs_attention between ticks — one notification on final state', async () => {
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-rapid', name: 'Only Step', agentId: AGENT },
			]);
			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');

			// Tick 1: task is pending — no notification
			await runtime.executeTick();
			expect(sink.events).toHaveLength(0);

			// Simulate rapid state transitions (between ticks in production, external agents do this):
			// pending → needs_attention → pending → in_progress → needs_attention
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'First failure' });
			taskRepo.updateTask(tasks[0].id, { status: 'pending', error: null });
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Final failure' });

			// Tick 2: task is in needs_attention in its final state — exactly 1 notification
			await runtime.executeTick();

			const naEvents = sink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(naEvents).toHaveLength(1);
			if (naEvents[0].kind === 'task_needs_attention') {
				expect(naEvents[0].reason).toBe('Final failure');
				expect(naEvents[0].taskId).toBe(tasks[0].id);
			}
		});

		test('standalone task rapid changes — only final needs_attention state generates notification', async () => {
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Rapid Standalone',
				description: '',
				status: 'pending',
			});

			// Tick 1: pending — no notification
			await runtime.executeTick();
			expect(sink.events).toHaveLength(0);

			// Simulate rapid status cycling (between ticks)
			taskRepo.updateTask(task.id, { status: 'needs_attention', error: 'Transient error' });
			taskRepo.updateTask(task.id, { status: 'pending', error: null });
			taskRepo.updateTask(task.id, { status: 'in_progress' });
			taskRepo.updateTask(task.id, { status: 'needs_attention', error: 'Persistent error' });

			// Tick 2: final state is needs_attention — exactly 1 notification
			await runtime.executeTick();

			const naEvents = sink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(naEvents).toHaveLength(1);
			if (naEvents[0].kind === 'task_needs_attention') {
				expect(naEvents[0].reason).toBe('Persistent error');
			}
		});

		test('task goes needs_attention→completed between ticks — dedup key cleared, completion handled', async () => {
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-rapid-done', name: 'Only Step', agentId: AGENT },
			]);
			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');

			// Tick 1: needs_attention — 1 notification
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Retry needed' });
			await runtime.executeTick();

			const naEvents1 = sink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(naEvents1).toHaveLength(1);

			// Between ticks: task is fixed and completed
			taskRepo.updateTask(tasks[0].id, { status: 'completed', error: null });

			// Tick 2: task completed, workflow run completes, workflow_run_completed emitted
			await runtime.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);

			// No additional task_needs_attention (task left that state)
			const naEvents2 = sink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(naEvents2).toHaveLength(1); // still only the original one
		});
	});

	// -------------------------------------------------------------------------
	// 3. SpaceRuntime rehydration with workflow tasks in needs_attention
	// -------------------------------------------------------------------------

	describe('rehydration — workflow tasks in needs_attention on restart', () => {
		test('workflow task in needs_attention is re-notified on first tick after restart', async () => {
			// Tick 1 on original runtime: task enters needs_attention
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-rehydrate', name: 'Only Step', agentId: AGENT },
			]);
			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Pre-restart error' });

			await runtime.executeTick();

			const originalEvents = sink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(originalEvents).toHaveLength(1);

			// Simulate daemon restart: create a fresh SpaceRuntime with empty dedup set
			// (in production, the daemon restarts from scratch and rehydrates from DB)
			const freshSink = new MockNotificationSink();
			const freshRuntime = makeRuntime({ notificationSink: freshSink });

			// First tick on fresh runtime: rehydrates the in-progress run from DB,
			// discovers the task is still in needs_attention, re-notifies once
			await freshRuntime.executeTick();

			const reNotified = freshSink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(reNotified).toHaveLength(1);
			if (reNotified[0].kind === 'task_needs_attention') {
				expect(reNotified[0].taskId).toBe(tasks[0].id);
				expect(reNotified[0].reason).toBe('Pre-restart error');
			}

			// Second tick on fresh runtime: deduped, no new notification
			await freshRuntime.executeTick();
			expect(freshSink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);
		});

		test('multiple workflow runs with needs_attention tasks — all re-notified after restart', async () => {
			// Set up two workflow runs, each with a task in needs_attention
			const wfA = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-rehy-a', name: 'Step A', agentId: AGENT },
			]);
			const wfB = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-rehy-b', name: 'Step B', agentId: AGENT },
			]);

			const { tasks: tasksA } = await runtime.startWorkflowRun(SPACE_ID, wfA.id, 'Run A');
			const { tasks: tasksB } = await runtime.startWorkflowRun(SPACE_ID, wfB.id, 'Run B');

			taskRepo.updateTask(tasksA[0].id, { status: 'needs_attention', error: 'Error A' });
			taskRepo.updateTask(tasksB[0].id, { status: 'needs_attention', error: 'Error B' });

			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(2);

			// Simulate restart
			const freshSink = new MockNotificationSink();
			const freshRuntime = makeRuntime({ notificationSink: freshSink });

			await freshRuntime.executeTick();

			const reNotified = freshSink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(reNotified).toHaveLength(2);

			const taskIds = reNotified.map((e) => (e.kind === 'task_needs_attention' ? e.taskId : ''));
			expect(taskIds).toContain(tasksA[0].id);
			expect(taskIds).toContain(tasksB[0].id);
		});

		test('gate-blocked run (needs_attention status) is re-notified after restart via checkStandaloneTasks path', async () => {
			// Build a two-step workflow with a human gate
			const wf = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: 'step-gate-r1', name: 'Plan', agentId: AGENT },
					{ id: 'step-gate-r2', name: 'Code', agentId: AGENT },
				],
				[{ type: 'human' }]
			);
			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Gated Run');

			// First step completes — gate fires, run enters needs_attention
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });
			await runtime.executeTick();

			const gateEvents = sink.events.filter((e) => e.kind === 'workflow_run_needs_attention');
			expect(gateEvents).toHaveLength(1);

			// Simulate restart: fresh runtime with empty dedup set
			const freshSink = new MockNotificationSink();
			const freshRuntime = makeRuntime({ notificationSink: freshSink });

			// Run is now in needs_attention status — on restart, processRunTick skips it
			// (run.status === 'needs_attention') so it will NOT be re-notified via the
			// workflow path. This is intentional: the gate event already fired.
			await freshRuntime.executeTick();

			// Workflow run needs_attention is NOT re-notified on restart (run stays terminal).
			// This is by design — the gate must be manually resolved first.
			const reGated = freshSink.events.filter((e) => e.kind === 'workflow_run_needs_attention');
			expect(reGated).toHaveLength(0);

			// Confirm run is still in needs_attention in DB
			const refreshedRun = workflowRunRepo.getRun(run.id);
			expect(refreshedRun?.status).toBe('needs_attention');
		});
	});

	// -------------------------------------------------------------------------
	// 4. Deduplication — standalone tasks across many ticks
	// -------------------------------------------------------------------------

	describe('deduplication — standalone tasks across many ticks', () => {
		test('same standalone task in needs_attention for 5+ ticks emits only 1 notification', async () => {
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Persistent Issue',
				description: '',
				status: 'needs_attention',
			});
			taskRepo.updateTask(task.id, { error: 'Persistent error' });

			// Run many ticks — should emit only 1 notification total
			for (let i = 0; i < 5; i++) {
				await runtime.executeTick();
			}

			const naEvents = sink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(naEvents).toHaveLength(1);
			if (naEvents[0].kind === 'task_needs_attention') {
				expect(naEvents[0].taskId).toBe(task.id);
			}
		});

		test('standalone task in timeout for 5+ ticks emits only 1 notification', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Stuck Standalone',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 30000, // 30s ago, well past 1s timeout
				task.id
			);

			for (let i = 0; i < 5; i++) {
				await runtime.executeTick();
			}

			const timeoutEvents = sink.events.filter((e) => e.kind === 'task_timeout');
			expect(timeoutEvents).toHaveLength(1);
		});

		test('dedup key refreshed after task resolves and re-enters needs_attention', async () => {
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Flapping Task',
				description: '',
				status: 'needs_attention',
			});
			taskRepo.updateTask(task.id, { error: 'First error' });

			// Tick 1 → 1 notification
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// Tick 2 → deduped, still 1
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// Task resolves (leaves needs_attention)
			taskRepo.updateTask(task.id, { status: 'in_progress', error: null });

			// Tick 3 → in_progress, no new notification
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// Task hits needs_attention again
			taskRepo.updateTask(task.id, { status: 'needs_attention', error: 'Second error' });

			// Tick 4 → dedup key cleared when task left needs_attention, so re-notifies
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(2);
		});
	});

	// -------------------------------------------------------------------------
	// 5. External run cancellation while notification is in flight
	// -------------------------------------------------------------------------

	describe('external run cancellation — no stale notifications', () => {
		test('run cancelled externally between ticks — no notification on subsequent tick', async () => {
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-cancel-ext', name: 'Only Step', agentId: AGENT },
			]);
			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');

			// Tick 1: task in_progress, no notification
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			await runtime.executeTick();
			expect(sink.events).toHaveLength(0);

			// External cancellation: update run status directly in DB (simulating external API call)
			workflowRunRepo.updateStatus(run.id, 'cancelled');

			// Tick 2: run is now cancelled, SpaceRuntime skips it in processRunTick
			// and cleanupTerminalExecutors removes it without emitting workflow_run_completed
			await runtime.executeTick();

			// No notifications for a cancelled run
			expect(sink.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(0);
		});

		test('run cancelled externally while task is in needs_attention — no stale task notification on next tick', async () => {
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-cancel-na', name: 'Only Step', agentId: AGENT },
			]);
			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Error' });

			// Tick 1: task_needs_attention emitted
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// External cancellation between ticks
			workflowRunRepo.updateStatus(run.id, 'cancelled');

			// Tick 2: run is cancelled, executor removed by cleanupTerminalExecutors.
			// No new notification should be emitted.
			await runtime.executeTick();

			// Still only 1 task_needs_attention (from tick 1)
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);
			// No workflow_run_completed for cancelled runs
			expect(sink.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);
		});

		test('run cancelled between rehydration and first tick — no notification emitted', async () => {
			// Start a run on the original runtime
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-cancel-rehy', name: 'Only Step', agentId: AGENT },
			]);
			const { run } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');

			// Simulate: between daemon restart and first tick, run gets cancelled externally
			workflowRunRepo.updateStatus(run.id, 'cancelled');

			// Fresh runtime (simulating restart): first executeTick() rehydrates,
			// then processes — cancelled run should emit nothing
			const freshSink = new MockNotificationSink();
			const freshRuntime = makeRuntime({ notificationSink: freshSink });

			await freshRuntime.executeTick();

			// No notifications for a run that was already cancelled before first tick
			expect(freshSink.events).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// 6. Session not available when notification fires — graceful degradation
	// -------------------------------------------------------------------------

	describe('SessionNotificationSink — session not available', () => {
		test('does not throw when session.injectMessage throws "session not found"', async () => {
			const factory = makeMockSessionFactory({
				injectError: new Error('Session not found: spaces:global:missing'),
			});
			const sessionSink = new SessionNotificationSink({
				sessionFactory: factory,
				sessionId: 'spaces:global:missing',
				autonomyLevel: 'supervised',
			});

			const event: SpaceNotificationEvent = {
				kind: 'task_needs_attention',
				spaceId: SPACE_ID,
				taskId: 'task-gone',
				reason: 'Task needs attention',
				timestamp: new Date().toISOString(),
			};

			// notify() must not throw — it should catch the error internally
			await expect(sessionSink.notify(event)).resolves.toBeUndefined();
		});

		test('does not throw when session.injectMessage throws a generic error', async () => {
			const factory = makeMockSessionFactory({
				injectError: new Error('Connection reset'),
			});
			const sessionSink = new SessionNotificationSink({
				sessionFactory: factory,
				sessionId: 'spaces:global:session-1',
				autonomyLevel: 'semi_autonomous',
			});

			const event: SpaceNotificationEvent = {
				kind: 'workflow_run_completed',
				spaceId: SPACE_ID,
				runId: 'run-1',
				status: 'completed',
				timestamp: new Date().toISOString(),
			};

			await expect(sessionSink.notify(event)).resolves.toBeUndefined();
		});

		test('SpaceRuntime tick survives when SessionNotificationSink session is deleted', async () => {
			// Wire SpaceRuntime with a SessionNotificationSink that throws on every call
			const factory = makeMockSessionFactory({
				injectError: new Error('Session deleted'),
			});
			const sessionSink = new SessionNotificationSink({
				sessionFactory: factory,
				sessionId: 'spaces:global:deleted',
				autonomyLevel: 'supervised',
			});
			const rt = makeRuntime({ notificationSink: sessionSink });

			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-deleted-sess', name: 'Only Step', agentId: AGENT },
			]);
			const { tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Error' });

			// Tick must survive even though session is deleted
			await expect(rt.executeTick()).resolves.toBeUndefined();

			// The factory never received a successful call (all threw)
			expect(factory.calls).toHaveLength(0);
		});

		test('SpaceRuntime continues processing all runs when SessionNotificationSink fails for one', async () => {
			let callCount = 0;
			const flakyFactory: SessionFactory & { successCalls: InjectedCall[] } = {
				successCalls: [],
				createAndStartSession: async () => {},
				injectMessage: async (sessionId, message, opts) => {
					callCount++;
					if (callCount === 1) {
						// First call fails (simulates session briefly unavailable)
						throw new Error('Session temporarily unavailable');
					}
					(flakyFactory.successCalls as InjectedCall[]).push({ sessionId, message, opts });
				},
				hasSession: () => true,
				answerQuestion: async () => false,
				createWorktree: async () => null,
				restoreSession: async () => false,
				startSession: async () => false,
				setSessionMcpServers: () => false,
				removeWorktree: async () => false,
			};

			const sessionSink = new SessionNotificationSink({
				sessionFactory: flakyFactory,
				sessionId: 'spaces:global:flaky',
				autonomyLevel: 'supervised',
			});
			const rt = makeRuntime({ notificationSink: sessionSink });

			// Run A: needs_attention (first notify call → session error)
			const wfA = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-flaky-sess-a', name: 'Step A', agentId: AGENT },
			]);
			const { tasks: tasksA } = await rt.startWorkflowRun(SPACE_ID, wfA.id, 'Run A');
			taskRepo.updateTask(tasksA[0].id, { status: 'needs_attention', error: 'Error A' });

			// Run B: needs_attention (second notify call → succeeds)
			const wfB = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-flaky-sess-b', name: 'Step B', agentId: AGENT },
			]);
			const { tasks: tasksB } = await rt.startWorkflowRun(SPACE_ID, wfB.id, 'Run B');
			taskRepo.updateTask(tasksB[0].id, { status: 'needs_attention', error: 'Error B' });

			// Tick must complete without crashing
			await expect(rt.executeTick()).resolves.toBeUndefined();

			// The second successful injection should be present
			expect(flakyFactory.successCalls).toHaveLength(1);
		});
	});
});
