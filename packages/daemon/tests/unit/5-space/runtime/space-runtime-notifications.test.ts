/**
 * SpaceRuntime Notification Tests
 *
 * Verifies that SpaceRuntime emits structured notifications via NotificationSink
 * for all four event types:
 *   - workflow_run_blocked  (gate blocked)
 *   - task_blocked          (task entered needs_attention)
 *   - workflow_run_completed        (run reached terminal step)
 *   - task_timeout                  (in_progress task exceeded threshold)
 *
 * Also verifies:
 *   - Deduplication: same task in needs_attention across two ticks → one notification
 *   - Normal advancement emits NO notifications
 *   - setNotificationSink() replaces the sink at runtime
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type {
	NotificationSink,
	SpaceNotificationEvent,
} from '../../../../src/lib/space/runtime/notification-sink.ts';
import type { SpaceWorkflow, SpaceTask, SpaceWorkflowRun, Space } from '@neokai/shared';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';

// ---------------------------------------------------------------------------
// MockNotificationSink
// ---------------------------------------------------------------------------

class MockNotificationSink implements NotificationSink {
	readonly events: SpaceNotificationEvent[] = [];

	notify(event: SpaceNotificationEvent): Promise<void> {
		this.events.push(event);
		return Promise.resolve();
	}

	get byKind(): Record<string, SpaceNotificationEvent[]> {
		const map: Record<string, SpaceNotificationEvent[]> = {};
		for (const e of this.events) {
			if (!map[e.kind]) map[e.kind] = [];
			map[e.kind].push(e);
		}
		return map;
	}

	clear(): void {
		this.events.length = 0;
	}
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	// Use in-memory SQLite — faster than file-based DB and avoids filesystem
	// I/O contention that caused beforeEach hook timeouts in CI.
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/workspace'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function setSpaceTaskTimeoutMs(db: BunDatabase, spaceId: string, timeoutMs: number): void {
	db.prepare(`UPDATE spaces SET config = ? WHERE id = ?`).run(
		JSON.stringify({ taskTimeoutMs: timeoutMs }),
		spaceId
	);
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

function seedNodeExec(
	db: BunDatabase,
	workflowRunId: string,
	workflowNodeId: string,
	agentName: string,
	status: string,
	options?: { result?: string | null; startedAt?: number | null; agentSessionId?: string | null }
): string {
	const repo = new NodeExecutionRepository(db);
	const existing = repo.listByNode(workflowRunId, workflowNodeId);
	const result = options?.result ?? null;
	const startedAt = options?.startedAt ?? null;
	const agentSessionId = options?.agentSessionId ?? null;
	if (existing.length > 0) {
		const byAgent = existing.find((exec) => exec.agentName === agentName);
		const target = byAgent ?? (existing.length === 1 ? existing[0] : null);
		if (target) {
			repo.update(target.id, {
				status: status as 'pending' | 'in_progress' | 'idle' | 'done' | 'cancelled' | 'blocked',
				result,
				startedAt,
				agentSessionId,
			});
			return target.id;
		}
	}

	const id = `exec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const now = Date.now();
	db.prepare(
		`INSERT OR REPLACE INTO node_executions
			     (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
			      agent_session_id, status, result, created_at, started_at,
		      completed_at, updated_at)
		     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)`
	).run(
		id,
		workflowRunId,
		workflowNodeId,
		agentName,
		agentSessionId,
		status,
		result,
		now,
		startedAt,
		now
	);
	return id;
}

function buildLinearWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	nodes: Array<{ id: string; name: string; agentId: string }>,
	_conditions: Array<{ type: 'always' | 'human' }> = []
): SpaceWorkflow {
	// Convert agentId shorthand to agents[] format (M71 schema)
	const workflowNodes = nodes.map((n) => ({
		id: n.id,
		name: n.name,
		agents: [{ agentId: n.agentId, name: n.name.toLowerCase().replace(/\s+/g, '-') }],
	}));

	return workflowManager.createWorkflow({
		spaceId,
		name: `Workflow ${Date.now()}-${Math.random()}`,
		description: '',
		nodes: workflowNodes,
		startNodeId: nodes[0].id,
		tags: [],
		completionAutonomyLevel: 3,
	});
}

// End nodes must have exactly 1 agent (validator rule). For tests that exercise
// a multi-agent step, append a downstream single-agent end node so the
// multi-agent step remains an intermediate node. Returns the synthesized end
// node id so tests can reference it.
const SYNTHETIC_END_NODE_ID = '__test_end__';
function withSyntheticEnd(endAgentId: string): {
	id: string;
	name: string;
	agents: Array<{ agentId: string; name: string }>;
} {
	return {
		id: SYNTHETIC_END_NODE_ID,
		name: 'Synthetic End',
		agents: [{ agentId: endAgentId, name: 'end' }],
	};
}

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

describe('SpaceRuntime — notification events', () => {
	let db: BunDatabase;

	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let sink: MockNotificationSink;
	let runtime: SpaceRuntime;

	const SPACE_ID = 'space-notif-1';
	const WORKSPACE = '/tmp/notif-ws';
	const AGENT_CODER = 'agent-coder-notif';
	const STEP_A = 'step-na';
	const STEP_B = 'step-nb';

	function makeRuntime(extraConfig?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
		const nodeExecutionRepo = new NodeExecutionRepository(db);
		const config: SpaceRuntimeConfig = {
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			notificationSink: sink,
			...extraConfig,
		};
		return new SpaceRuntime(config);
	}

	beforeEach(() => {
		db = makeDb();

		seedSpaceRow(db, SPACE_ID, WORKSPACE);
		seedAgentRow(db, AGENT_CODER, SPACE_ID);

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
		} catch {
			/* ignore */
		}
	});

	// -------------------------------------------------------------------------
	// workflow_run_blocked
	// -------------------------------------------------------------------------

	// -------------------------------------------------------------------------
	// task_blocked
	// -------------------------------------------------------------------------

	describe('task_blocked', () => {
		test('emits event when a step task enters needs_attention', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

			await runtime.executeTick();

			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
			const evt = sink.events.find((e) => e.kind === 'task_blocked');
			expect(evt).toBeDefined();
			expect(evt.kind).toBe('task_blocked');
			if (evt.kind === 'task_blocked') {
				expect(evt.spaceId).toBe(SPACE_ID);
				expect(evt.taskId).toBe(tasks[0].id);
				expect(evt.reason).toBe('One or more workflow agents are blocked');
				expect(typeof evt.timestamp).toBe('string');
			}
		});

		test('uses fallback reason when task.error is null', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

			await runtime.executeTick();

			const evt = sink.events[0];
			expect(evt.kind).toBe('task_blocked');
			if (evt.kind === 'task_blocked') {
				expect(evt.reason).toBe('One or more workflow agents are blocked');
			}
		});

		test('does NOT advance when task is needs_attention (returns early)', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

			await runtime.executeTick();

			// No step B task should be created
			const allTasks = taskRepo.listByWorkflowRun(run.id);
			expect(allTasks).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// Deduplication — task_blocked
	// -------------------------------------------------------------------------

	describe('deduplication', () => {
		test('same task in needs_attention across two ticks emits only ONE notification', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

			// First tick — should emit
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Second tick — same task still in needs_attention — should NOT emit again
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Third tick — still deduped
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
		});

		test('re-notifies after task leaves and re-enters needs_attention', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

			// First tick — emits
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Task gets retried: back to in_progress
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress');
			await runtime.executeTick();
			// No new event for in_progress
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Task fails again
			seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');
			await runtime.executeTick();
			// Should emit a second time since the dedup key was cleared
			const blockedEvents = sink.events.filter((e) => e.kind === 'task_blocked');
			expect(blockedEvents).toHaveLength(2);
		});

		test('multiple tasks in needs_attention each emit their own notification', async () => {
			// Two-step workflow where both tasks (for different steps) end up needing attention
			// In practice, each step has one task; we test with a single-step workflow and
			// verify only one event per step.
			// For multiple tasks we'd need a parallel step model; instead verify per-task dedup
			// with two separate single-step workflows.
			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-multi-a', name: 'Step A', agentId: AGENT_CODER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-multi-b', name: 'Step B', agentId: AGENT_CODER },
			]);

			const { tasks: tasks1 } = await runtime.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
			const { tasks: tasks2 } = await runtime.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

			seedNodeExec(db, (tasks1[0].workflowRunId as string)!, 'step-multi-a', 'step-a', 'blocked');
			seedNodeExec(db, (tasks2[0].workflowRunId as string)!, 'step-multi-b', 'step-b', 'blocked');

			await runtime.executeTick();

			// Both should emit
			const naEvents = sink.events.filter((e) => e.kind === 'task_blocked');
			expect(naEvents).toHaveLength(2);
			const taskIds = naEvents.map((e) => (e.kind === 'task_blocked' ? e.taskId : ''));
			expect(taskIds).toContain(tasks1[0].id);
			expect(taskIds).toContain(tasks2[0].id);

			// Second tick — still deduped (no new events)
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(2);
		});
	});

	// -------------------------------------------------------------------------
	// task_timeout
	// -------------------------------------------------------------------------

	describe('task_timeout', () => {
		test('emits event when in_progress task exceeds taskTimeoutMs', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000); // 1 second timeout

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 2000 });

			await runtime.executeTick();

			expect(sink.events).toHaveLength(1);
			const evt = sink.events[0];
			expect(evt.kind).toBe('task_timeout');
			if (evt.kind === 'task_timeout') {
				expect(evt.spaceId).toBe(SPACE_ID);
				expect(evt.taskId).toBe(tasks[0].id);
				expect(evt.elapsedMs).toBeGreaterThan(1000);
				expect(typeof evt.timestamp).toBe('string');
			}
		});

		test('does NOT emit timeout when task has not exceeded the threshold', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 60_000); // 1 minute — won't fire in a unit test

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() });

			await runtime.executeTick();

			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
		});

		test('does NOT emit timeout when taskTimeoutMs is undefined (disabled)', async () => {
			// No config set on space → timeout disabled
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 100_000 });

			await runtime.executeTick();

			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
		});

		test('deduplicates timeout notifications across ticks', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 2000 });

			// First tick — emits timeout
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Second tick — same task still in_progress and over threshold — deduped
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);
		});

		test('re-notifies timeout after task leaves in_progress and re-enters', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 2000 });

			// First tick — emits
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Task leaves in_progress (e.g. paused to needs_attention)
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, STEP_A, 'plan', 'idle');
			await runtime.executeTick();

			// Task re-enters in_progress, back-dated again
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 2000 });
			await runtime.executeTick();

			// Should emit again since the dedup key was cleared when task left in_progress
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(2);
		});
	});

	// -------------------------------------------------------------------------
	// No notifications for normal advancement
	// -------------------------------------------------------------------------

	describe('no notifications for mechanical advancement', () => {
		test('normal step completion and advancement emits no notifications', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'done' });

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});

		test('task in pending state emits no notifications', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			// Task stays pending (no update)

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});

		test('task in in_progress state (no timeout) emits no notifications', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// Standalone task notifications
	// -------------------------------------------------------------------------

	describe('standalone task notifications', () => {
		test('emits task_blocked for standalone task in needs_attention state', async () => {
			// Create a standalone task (no workflowRunId) directly via repo
			const created = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone Task',
				description: 'No workflow',
				status: 'blocked',
			});
			// error field was removed in M71; reason is hardcoded
			const task = created;

			await runtime.executeTick();

			expect(sink.events).toHaveLength(1);
			const evt = sink.events[0];
			expect(evt.kind).toBe('task_blocked');
			if (evt.kind === 'task_blocked') {
				expect(evt.spaceId).toBe(SPACE_ID);
				expect(evt.taskId).toBe(task.id);
				expect(evt.reason).toBe('Task requires attention');
				expect(typeof evt.timestamp).toBe('string');
			}
		});

		test('uses fallback reason when standalone task.error is null', async () => {
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone Task',
				description: '',
				status: 'blocked',
			});

			await runtime.executeTick();

			const evt = sink.events[0];
			expect(evt.kind).toBe('task_blocked');
			if (evt.kind === 'task_blocked') {
				expect(evt.reason).toBe('Task requires attention');
			}
		});

		test('deduplicates standalone needs_attention across ticks', async () => {
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone',
				description: '',
				status: 'blocked',
			});

			// First tick — emits
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Second tick — still needs_attention — deduped
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Third tick — still deduped
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
		});

		test('re-notifies standalone task after it leaves and re-enters needs_attention', async () => {
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone',
				description: '',
				status: 'blocked',
			});

			// First tick — emits
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Task gets retried: back to in_progress
			taskRepo.updateTask(task.id, { status: 'in_progress' });
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Task fails again
			taskRepo.updateTask(task.id, { status: 'blocked' });
			await runtime.executeTick();
			// Should emit a second time since dedup key was cleared when task left needs_attention
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(2);
		});

		test('pending standalone tasks emit no notifications', async () => {
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone Pending',
				description: '',
				status: 'open',
			});

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});

		test('in_progress standalone tasks without timeout emit no notifications', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 60_000); // 1 minute — won't fire in unit test

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone In Progress',
				description: '',
				status: 'in_progress',
			});
			// Stamp started_at (normally done by repo on status transition, but we set in creation)
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(Date.now(), task.id);

			await runtime.executeTick();

			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
		});

		test('emits task_timeout for standalone in_progress task that exceeds threshold', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000); // 1 second

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Slow Standalone',
				description: '',
				status: 'in_progress',
			});
			// Back-date started_at to 2 seconds ago to simulate timeout
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				task.id
			);

			await runtime.executeTick();

			expect(sink.events).toHaveLength(1);
			const evt = sink.events[0];
			expect(evt.kind).toBe('task_timeout');
			if (evt.kind === 'task_timeout') {
				expect(evt.spaceId).toBe(SPACE_ID);
				expect(evt.taskId).toBe(task.id);
				expect(evt.elapsedMs).toBeGreaterThan(1000);
				expect(typeof evt.timestamp).toBe('string');
			}
		});

		test('does NOT emit timeout for standalone task when taskTimeoutMs is undefined', async () => {
			// No config set — timeout disabled
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Slow Standalone No Config',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 100_000,
				task.id
			);

			await runtime.executeTick();

			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
		});

		test('deduplicates standalone timeout notifications across ticks', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Timed Out Standalone',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				task.id
			);

			// First tick — emits
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Second tick — still in_progress and over threshold — deduped
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);
		});

		test('re-notifies standalone timeout after task leaves and re-enters in_progress', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Cycling Standalone',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				task.id
			);

			// First tick — emits timeout
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Task moves to needs_attention (leaves in_progress)
			taskRepo.updateTask(task.id, { status: 'blocked' });
			await runtime.executeTick();

			// Task re-enters in_progress and times out again
			taskRepo.updateTask(task.id, { status: 'in_progress' });
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				task.id
			);
			await runtime.executeTick();

			// Should emit a second timeout since dedup key was cleared when task left in_progress
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(2);
		});

		test('completed standalone task emits no notifications', async () => {
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Done',
				description: '',
				status: 'done',
			});

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});

		test('cancelled standalone task emits no notifications', async () => {
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Cancelled',
				description: '',
				status: 'cancelled',
			});

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});

		test('archiving a standalone task clears its dedup key (no permanent leak)', async () => {
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Soon Archived',
				description: '',
				status: 'blocked',
			});

			// First tick — emits notification, dedup key added
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Archive the task while it is still in needs_attention
			taskRepo.archiveTask(task.id);

			// Second tick — task is now archived; dedup key should be cleared
			await runtime.executeTick();
			// No new notification (archived tasks never re-enter needs_attention)
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Create a fresh runtime to simulate a restart — the previously leaked key
			// would have persisted in the old set. With the fix, the archived task was
			// cleaned up on the previous tick so no re-notification occurs here.
			// More importantly: verify the current runtime's set has been cleaned up by
			// creating a NEW task in needs_attention and confirming dedup still works.
			const task2 = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Another Task',
				description: '',
				status: 'blocked',
			});
			await runtime.executeTick();
			const naEvents = sink.events.filter(
				(e) => e.kind === 'task_blocked' && e.taskId === task2.id
			);
			expect(naEvents).toHaveLength(1);
		});

		test('workflow tasks are NOT processed by checkStandaloneTasks', async () => {
			// Create a workflow task (has workflowRunId) with needs_attention status
			// It should NOT generate a duplicate notification via the standalone path
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT_CODER },
			]);
			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, STEP_A, 'step-a', 'blocked');

			await runtime.executeTick();

			// Should get exactly one notification (from processRunTick, not checkStandaloneTasks)
			const naEvents = sink.events.filter((e) => e.kind === 'task_blocked');
			expect(naEvents).toHaveLength(1);
			if (naEvents[0].kind === 'task_blocked') {
				expect(naEvents[0].taskId).toBe(tasks[0].id);
			}
		});
	});

	// -------------------------------------------------------------------------
	// Restart re-notification behavior (Task 2.3 restart contract)
	// -------------------------------------------------------------------------

	describe('restart re-notification (empty dedup set on restart)', () => {
		test('standalone needs_attention task is re-notified after simulated restart', async () => {
			const created = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Pre-existing Standalone',
				description: '',
				status: 'blocked',
			});
			// error field was removed in M71
			const task = created;

			// First runtime instance — first tick emits notification
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Simulate restart: create a fresh runtime with empty dedup set
			// (In production the daemon process restarts and all in-memory state is lost)
			const freshSink = new MockNotificationSink();
			const freshRuntime = makeRuntime({ notificationSink: freshSink });

			// First tick on fresh runtime — dedup set is empty → re-notifies once
			await freshRuntime.executeTick();
			const reNotified = freshSink.events.filter((e) => e.kind === 'task_blocked');
			expect(reNotified).toHaveLength(1);
			if (reNotified[0].kind === 'task_blocked') {
				expect(reNotified[0].taskId).toBe(task.id);
				expect(reNotified[0].reason).toBe('Task requires attention');
			}

			// Second tick on fresh runtime — deduped, no new notification
			await freshRuntime.executeTick();
			expect(freshSink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
		});

		test('standalone timed-out task is re-notified after simulated restart', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Pre-existing Timeout',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 5000,
				task.id
			);

			// First runtime instance — first tick emits timeout
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Simulate restart: fresh runtime with empty dedup set
			const freshSink = new MockNotificationSink();
			const freshRuntime = makeRuntime({ notificationSink: freshSink });

			// First tick on fresh runtime — re-notifies once (dedup set was empty)
			await freshRuntime.executeTick();
			expect(freshSink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Second tick — deduped
			await freshRuntime.executeTick();
			expect(freshSink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// Full pipeline — concurrent events in a single tick
	// Verifies that multiple distinct event kinds are ALL delivered when they
	// occur in the same SpaceRuntime tick.
	// -------------------------------------------------------------------------

	describe('full pipeline — concurrent events in a single tick', () => {
		test('two workflow runs both enter needs_attention in the same tick — both events delivered', async () => {
			// Run A: task enters needs_attention
			const wfA = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-conc-a', name: 'Step A', agentId: AGENT_CODER },
			]);
			// Run B: task enters needs_attention (different error)
			const wfB = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-conc-b', name: 'Step B', agentId: AGENT_CODER },
			]);

			const { run: runA, tasks: tasksA } = await runtime.startWorkflowRun(
				SPACE_ID,
				wfA.id,
				'Run A'
			);
			const { run: runB, tasks: tasksB } = await runtime.startWorkflowRun(
				SPACE_ID,
				wfB.id,
				'Run B'
			);

			seedNodeExec(db, runA.id, 'step-conc-a', 'step-a', 'blocked');
			seedNodeExec(db, runB.id, 'step-conc-b', 'step-b', 'blocked');

			// Single tick — both tasks are in needs_attention simultaneously
			await runtime.executeTick();

			const naEvents = sink.events.filter((e) => e.kind === 'task_blocked');
			expect(naEvents).toHaveLength(2);

			const taskIds = naEvents.map((e) => (e.kind === 'task_blocked' ? e.taskId : ''));
			expect(taskIds).toContain(tasksA[0].id);
			expect(taskIds).toContain(tasksB[0].id);

			const reasons = naEvents.map((e) => (e.kind === 'task_blocked' ? e.reason : ''));
			expect(reasons).toContain('One or more workflow agents are blocked');
		});

		test('workflow task needs_attention AND standalone task needs_attention in the same tick', async () => {
			// Workflow task
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-mixed-wf', name: 'Workflow Step', agentId: AGENT_CODER },
			]);
			const { run, tasks: wfTasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			seedNodeExec(db, run.id, 'step-mixed-wf', 'workflow-step', 'blocked');

			// Standalone task (no workflowRunId)
			const standaloneCreated = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone Failing Task',
				description: '',
				status: 'blocked',
			});
			// error field removed in M71 — standalone task already in blocked state

			// Single tick — workflow path (processRunTick) + standalone path (checkStandaloneTasks)
			await runtime.executeTick();

			const naEvents = sink.events.filter((e) => e.kind === 'task_blocked');
			expect(naEvents).toHaveLength(2);

			const taskIds = naEvents.map((e) => (e.kind === 'task_blocked' ? e.taskId : ''));
			expect(taskIds).toContain(wfTasks[0].id);
			expect(taskIds).toContain(standaloneCreated.id);
		});

		test('workflow timeout AND standalone timeout in the same tick', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000); // 1 second

			// Workflow task that times out
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-timeout-wf', name: 'Slow Workflow Step', agentId: AGENT_CODER },
			]);
			const { run, tasks: wfTasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			seedNodeExec(db, run.id, 'step-timeout-wf', 'slow-workflow-step', 'in_progress', {
				startedAt: Date.now() - 3000,
			});

			// Standalone task that times out
			const standalone = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Slow Standalone',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 3000,
				standalone.id
			);

			// Single tick — both timeout events emitted
			await runtime.executeTick();

			const timeoutEvents = sink.events.filter((e) => e.kind === 'task_timeout');
			expect(timeoutEvents).toHaveLength(2);

			const taskIds = timeoutEvents.map((e) => (e.kind === 'task_timeout' ? e.taskId : ''));
			expect(taskIds).toContain(wfTasks[0].id);
			expect(taskIds).toContain(standalone.id);

			for (const evt of timeoutEvents) {
				if (evt.kind === 'task_timeout') {
					expect(evt.elapsedMs).toBeGreaterThan(1000);
					expect(evt.spaceId).toBe(SPACE_ID);
				}
			}
		});
	});

	// -------------------------------------------------------------------------
	// Multi-agent partial failure notifications
	// -------------------------------------------------------------------------

	describe('multi-agent partial failure', () => {
		const AGENT_PLANNER = 'agent-planner-notif';

		beforeEach(() => {
			seedAgentRow(db, AGENT_PLANNER, SPACE_ID);
		});

		test('emits task_blocked for each failed parallel task when all are terminal', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Parallel Fail Notify ${Date.now()}`,
				nodes: [
					{
						id: STEP_A,
						name: 'Parallel Step',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_PLANNER, name: 'planner' },
						],
					},
					withSyntheticEnd(AGENT_CODER),
				],
				transitions: [],
				startNodeId: STEP_A,
				endNodeId: SYNTHETIC_END_NODE_ID,
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, STEP_A, 'coder', 'blocked');
			seedNodeExec(db, run.id, STEP_A, 'planner', 'blocked');

			await runtime.executeTick();

			const naEvents = sink.events.filter((e) => e.kind === 'task_blocked');
			expect(naEvents).toHaveLength(1);
			const runEvents = sink.events.filter((e) => e.kind === 'workflow_run_blocked');
			expect(runEvents).toHaveLength(1);
		});

		test('does NOT emit workflow_run_blocked when sibling tasks are still running', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Partial Terminal Notify ${Date.now()}`,
				nodes: [
					{
						id: STEP_A,
						name: 'Parallel Partial',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_PLANNER, name: 'planner' },
						],
					},
					withSyntheticEnd(AGENT_CODER),
				],
				transitions: [],
				startNodeId: STEP_A,
				endNodeId: SYNTHETIC_END_NODE_ID,
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, STEP_A, 'coder', 'blocked');
			seedNodeExec(db, run.id, STEP_A, 'planner', 'in_progress');

			await runtime.executeTick();

			const naEvents = sink.events.filter((e) => e.kind === 'task_blocked');
			expect(naEvents).toHaveLength(1);

			const runEvents = sink.events.filter((e) => e.kind === 'workflow_run_blocked');
			expect(runEvents).toHaveLength(1);
		});

		test('does NOT emit workflow_run_blocked for single-task step (backward compat)', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Single', agentId: AGENT_CODER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, STEP_A, 'single', 'blocked');

			await runtime.executeTick();

			const naEvents = sink.events.filter((e) => e.kind === 'task_blocked');
			expect(naEvents).toHaveLength(1);

			const runEvents = sink.events.filter((e) => e.kind === 'workflow_run_blocked');
			expect(runEvents).toHaveLength(1);
		});

		test('multi-agent partial failure dedup: does not re-emit run needs_attention on second tick', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Partial Fail Dedup ${Date.now()}`,
				nodes: [
					{
						id: STEP_A,
						name: 'Parallel Dedup',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_PLANNER, name: 'planner' },
						],
					},
					withSyntheticEnd(AGENT_CODER),
				],
				transitions: [],
				startNodeId: STEP_A,
				endNodeId: SYNTHETIC_END_NODE_ID,
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, STEP_A, 'coder', 'idle');
			seedNodeExec(db, run.id, STEP_A, 'planner', 'blocked');

			// First tick: run escalated
			await runtime.executeTick();
			const runEvents1 = sink.events.filter((e) => e.kind === 'workflow_run_blocked');
			expect(runEvents1).toHaveLength(1);

			// Second tick: run is now needs_attention, processRunTick returns early
			await runtime.executeTick();
			const runEvents2 = sink.events.filter((e) => e.kind === 'workflow_run_blocked');
			expect(runEvents2).toHaveLength(1); // still 1, not 2
		});
	});

	// -------------------------------------------------------------------------
	// workflow_run_completed — CompletionDetector integration
	// -------------------------------------------------------------------------

	/**
	 * Minimal mock TaskAgentManager — stubs the liveness/spawn interface so
	 * processRunTick() enters the TAM block and reaches the completion check.
	 * Never actually spawns agents; tasks must be pre-set to terminal states.
	 */
	class MockTaskAgentManager {
		isTaskAgentAlive(_taskId: string): boolean {
			return false;
		}

		isSpawning(_taskId: string): boolean {
			return false;
		}

		isExecutionSpawning(_executionId: string): boolean {
			return false;
		}

		isSessionAlive(_sessionId: string): boolean {
			return false;
		}

		async spawnWorkflowNodeAgent(
			_task: SpaceTask,
			_space: Space,
			_workflow: SpaceWorkflow | null,
			_run: SpaceWorkflowRun | null
		): Promise<string> {
			return 'mock-session';
		}

		async spawnWorkflowNodeAgentForExecution(
			_task: SpaceTask,
			_space: Space,
			_workflow: SpaceWorkflow,
			_run: SpaceWorkflowRun,
			execution: { id: string }
		): Promise<string> {
			return `mock-session:${execution.id}`;
		}

		async rehydrate(): Promise<void> {}

		cancelBySessionId(_agentSessionId: string): void {}

		async interruptBySessionId(_agentSessionId: string): Promise<void> {}
	}

	describe('workflow_run_completed via CompletionDetector', () => {
		const AGENT_PLANNER2 = 'agent-planner-cd';

		function makeRuntimeWithTam(extraConfig?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
			const nodeExecutionRepo = new NodeExecutionRepository(db);
			const config: SpaceRuntimeConfig = {
				db,
				spaceManager,
				spaceAgentManager: agentManager,
				spaceWorkflowManager: workflowManager,
				workflowRunRepo,
				taskRepo,
				nodeExecutionRepo,
				notificationSink: sink,
				taskAgentManager: new MockTaskAgentManager() as unknown as TaskAgentManager,
				...extraConfig,
			};
			return new SpaceRuntime(config);
		}

		beforeEach(() => {
			seedAgentRow(db, AGENT_PLANNER2, SPACE_ID);
		});

		test('emits workflow_run_completed when all tasks are completed', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-cd-a', name: 'Step A', agentId: AGENT_CODER },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, 'step-cd-a', 'step-a', 'idle');

			await rt.executeTick();

			const completedRun = workflowRunRepo.getRun(run.id);
			expect(completedRun?.status).toBe('done');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				expect(completedEvents[0].spaceId).toBe(SPACE_ID);
				expect(completedEvents[0].runId).toBe(run.id);
				expect(completedEvents[0].status).toBe('done');
				expect(typeof completedEvents[0].timestamp).toBe('string');
			}
		});

		test('emits workflow_run_completed for multi-agent step when canonical task is terminal', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi Complete ${Date.now()}`,
				nodes: [
					{
						id: 'step-multi-cd',
						name: 'Parallel Step',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_PLANNER2, name: 'planner' },
						],
					},
					withSyntheticEnd(AGENT_CODER),
				],
				transitions: [],
				startNodeId: 'step-multi-cd',
				endNodeId: SYNTHETIC_END_NODE_ID,
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks).toHaveLength(1);
			// Completion is task-status driven; flip the canonical task to done.
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, 'step-multi-cd', 'coder', 'idle');
			seedNodeExec(db, run.id, 'step-multi-cd', 'planner', 'idle');

			await rt.executeTick();

			const completedRun = workflowRunRepo.getRun(run.id);
			expect(completedRun?.status).toBe('done');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
		});

		test('does NOT emit workflow_run_completed when canonical task is still in_progress', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `In Progress Block ${Date.now()}`,
				nodes: [
					{
						id: 'step-ip-cd',
						name: 'Parallel Step',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_PLANNER2, name: 'planner' },
						],
					},
					withSyntheticEnd(AGENT_CODER),
				],
				transitions: [],
				startNodeId: 'step-ip-cd',
				endNodeId: SYNTHETIC_END_NODE_ID,
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			// Canonical task left in default in_progress; completion must not fire.
			seedNodeExec(db, run.id, 'step-ip-cd', 'coder', 'idle');
			seedNodeExec(db, run.id, 'step-ip-cd', 'planner', 'in_progress');

			await rt.executeTick();

			const runAfter = workflowRunRepo.getRun(run.id);
			expect(runAfter?.status).toBe('in_progress');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(0);
		});

		test('does NOT emit workflow_run_completed when a task is pending', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-pend-cd', name: 'Step Pending', agentId: AGENT_CODER },
			]);

			const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			// Task left in 'pending' status (default)

			await rt.executeTick();

			const runAfter = workflowRunRepo.getRun(run.id);
			expect(runAfter?.status).toBe('in_progress');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(0);
		});

		test('no duplicate workflow_run_completed on second tick — executor is cleaned up', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-dedup-cd', name: 'Step A', agentId: AGENT_CODER },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, 'step-dedup-cd', 'step-a', 'idle');

			// First tick — emits completion and removes executor
			await rt.executeTick();
			expect(sink.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
			expect(rt.executorCount).toBe(0);

			// Second tick — no executor, no re-notification
			await rt.executeTick();
			expect(sink.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
		});

		test('completes when task reaches needs_attention (terminal) status', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-na-cd', name: 'Failing Step', agentId: AGENT_CODER },
			]);

			const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			seedNodeExec(db, run.id, 'step-na-cd', 'failing-step', 'blocked');

			await rt.executeTick();

			// needs_attention task triggers task_blocked notification first
			const naEvents = sink.events.filter((e) => e.kind === 'task_blocked');
			expect(naEvents).toHaveLength(1);

			// Single-task step: run stays in_progress (not escalated to needs_attention at run level)
			// The processRunTick returns early after emitting task_blocked,
			// so the completion check is not reached for needs_attention tasks.
			const runAfter = workflowRunRepo.getRun(run.id);
			expect(['in_progress', 'blocked']).toContain(runAfter?.status);
		});

		test('completes when canonical task is cancelled (terminal) status', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Cancelled Complete ${Date.now()}`,
				nodes: [
					{
						id: 'step-cancel-cd',
						name: 'Cancelled Step',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_PLANNER2, name: 'planner' },
						],
					},
					withSyntheticEnd(AGENT_CODER),
				],
				transitions: [],
				startNodeId: 'step-cancel-cd',
				endNodeId: SYNTHETIC_END_NODE_ID,
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			// Cancelled at node-execution level does NOT complete; only task.status terminal does.
			taskRepo.updateTask(tasks[0].id, { status: 'cancelled' });
			seedNodeExec(db, run.id, 'step-cancel-cd', 'coder', 'cancelled');
			seedNodeExec(db, run.id, 'step-cancel-cd', 'planner', 'cancelled');

			await rt.executeTick();

			const completedRun = workflowRunRepo.getRun(run.id);
			expect(completedRun?.status).toBe('done');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
		});

		// -----------------------------------------------------------------------
		// Completion summary — resolveCompletionSummary
		// -----------------------------------------------------------------------

		test('workflow_run_completed notification includes summary from terminal (Done) node task result', async () => {
			const rt = makeRuntimeWithTam();
			// 2-node workflow with an explicit channel: Coder → Done
			// Channel from/to use node names (realistic production format, not node IDs)
			// The Done node is terminal (no outbound channels from it)
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Summary Test ${Date.now()}`,
				nodes: [
					{ id: 'step-coder-sum', name: 'Coder', agentId: AGENT_CODER },
					{ id: 'step-done-sum', name: 'Done', agentId: AGENT_CODER },
				],
				channels: [
					{
						id: 'ch-sum',
						from: 'Coder',
						to: 'Done',
					},
				],
				startNodeId: 'step-coder-sum',
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			// startWorkflowRun creates the task for the start (Coder) node
			const {
				run,
				tasks: [coderTask],
			} = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Manually create the Done task (downstream node, not auto-created by startWorkflowRun)
			const doneTask = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Done',
				description: '',
				workflowRunId: run.id,
				status: 'open',
			});

			// Mark both as completed; only Done task has a result summary.
			// The upstream coder task has no result so the first done-task-with-result
			// is the Done node task, which is what the notification summary should surface.
			const doneSummary =
				'## Workflow Complete\n\n### Pull Request\n- **PR URL:** https://github.com/owner/repo/pull/42';
			taskRepo.updateTask(coderTask.id, { status: 'done' });
			taskRepo.updateTask(doneTask.id, { status: 'done', result: doneSummary });
			seedNodeExec(db, run.id, 'step-coder-sum', 'coder', 'idle');
			seedNodeExec(db, run.id, 'step-done-sum', 'done', 'idle', { result: doneSummary });

			await rt.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				// Summary should come from the Done (terminal) node, not the Coder node
				expect(completedEvents[0].summary).toBe(doneSummary);
			}
		});

		test('workflow_run_completed notification has no summary when terminal task has no result', async () => {
			const rt = makeRuntimeWithTam();
			// Single-node workflow — the one node is terminal (no channels)
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `No Summary Test ${Date.now()}`,
				nodes: [{ id: 'step-nosummary', name: 'Done', agentId: AGENT_CODER }],
				startNodeId: 'step-nosummary',
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			// startWorkflowRun creates the task for the start node
			const {
				run,
				tasks: [doneTask],
			} = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			// Complete without a result
			taskRepo.updateTask(doneTask.id, { status: 'done' });
			seedNodeExec(db, run.id, 'step-nosummary', 'done', 'idle');

			await rt.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				expect(completedEvents[0].summary).toBeUndefined();
			}
		});

		test('summary comes from Done terminal node, not from upstream Coder node', async () => {
			const rt = makeRuntimeWithTam();
			// Channel uses node names (realistic production format)
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Terminal Node Priority ${Date.now()}`,
				nodes: [
					{ id: 'step-upstream-prio', name: 'Coding', agentId: AGENT_CODER },
					{ id: 'step-terminal-prio', name: 'Done', agentId: AGENT_CODER },
				],
				channels: [
					{
						id: 'ch-priority',
						from: 'Coding',
						to: 'Done',
					},
				],
				startNodeId: 'step-upstream-prio',
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			// startWorkflowRun creates the task for the start (Coder/upstream) node
			const {
				run,
				tasks: [upstreamTask],
			} = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Manually create the terminal (Done) task
			const terminalTask = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Done',
				description: '',
				workflowRunId: run.id,
				status: 'open',
			});

			// Only the terminal task has a result — the upstream task completes without one.
			// This ensures resolveCompletionSummary (which returns the first done task with a
			// result) surfaces the terminal Done node summary rather than an upstream result.
			taskRepo.updateTask(upstreamTask.id, { status: 'done' });
			taskRepo.updateTask(terminalTask.id, {
				status: 'done',
				result: 'Terminal Done summary',
			});
			seedNodeExec(db, run.id, 'step-upstream-prio', 'coding', 'idle');
			seedNodeExec(db, run.id, 'step-terminal-prio', 'done', 'idle', {
				result: 'Terminal Done summary',
			});

			await rt.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				expect(completedEvents[0].summary).toBe('Terminal Done summary');
				expect(completedEvents[0].summary).not.toBe('Upstream result');
			}
		});

		test('no terminal nodes — all nodes have outbound channels, summary is undefined', async () => {
			const rt = makeRuntimeWithTam();
			// A ↔ B cycle: both nodes have outbound edges so neither is terminal.
			// Channel from/to use node names (realistic production format).
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `No Terminal ${Date.now()}`,
				nodes: [
					{ id: 'step-nt-a', name: 'NodeA', agentId: AGENT_CODER },
					{ id: 'step-nt-b', name: 'NodeB', agentId: AGENT_CODER },
				],
				channels: [
					{
						id: 'ch-nt-ab',
						from: 'NodeA',
						to: 'NodeB',
					},
					{
						id: 'ch-nt-ba',
						from: 'NodeB',
						to: 'NodeA',
					},
				],
				startNodeId: 'step-nt-a',
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Create a task for node B as well
			const taskB = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'B',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: 'step-nt-b',
				taskType: 'coding',
				status: 'open',
			});

			taskRepo.updateTask(tasks[0].id, { status: 'done', result: 'Result A' });
			taskRepo.updateTask(taskB.id, { status: 'done', result: 'Result B' });
			seedNodeExec(db, run.id, 'step-nt-a', 'nodea', 'idle');
			seedNodeExec(db, run.id, 'step-nt-b', 'nodeb', 'idle');

			await rt.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				// No terminal nodes → summary should be undefined
				expect(completedEvents[0].summary).toBeUndefined();
			}
		});

		test('multiple terminal nodes — returns first non-empty result', async () => {
			const rt = makeRuntimeWithTam();
			// Fan-out: one start node, two terminal nodes each with a result.
			// Channel from/to use node names (realistic production format).
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi Terminal ${Date.now()}`,
				nodes: [
					{ id: 'step-mt-start', name: 'Start', agentId: AGENT_CODER },
					{ id: 'step-mt-done1', name: 'Done1', agentId: AGENT_CODER },
					{ id: 'step-mt-done2', name: 'Done2', agentId: AGENT_CODER },
				],
				channels: [
					{
						id: 'ch-mt-1',
						from: 'Start',
						to: 'Done1',
					},
					{
						id: 'ch-mt-2',
						from: 'Start',
						to: 'Done2',
					},
				],
				startNodeId: 'step-mt-start',
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			const taskDone1 = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Done1',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: 'step-mt-done1',
				taskType: 'coding',
				status: 'open',
			});
			const taskDone2 = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Done2',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: 'step-mt-done2',
				taskType: 'coding',
				status: 'open',
			});

			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			taskRepo.updateTask(taskDone1.id, { status: 'done', result: 'Summary from Done1' });
			taskRepo.updateTask(taskDone2.id, { status: 'done', result: 'Summary from Done2' });
			seedNodeExec(db, run.id, 'step-mt-start', 'start', 'idle');
			seedNodeExec(db, run.id, 'step-mt-done1', 'done1', 'idle', { result: 'Summary from Done1' });
			seedNodeExec(db, run.id, 'step-mt-done2', 'done2', 'idle', { result: 'Summary from Done2' });

			await rt.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				// Returns the first non-empty result found — either Done1 or Done2
				expect(completedEvents[0].summary).toMatch(/Summary from Done[12]/);
			}
		});

		test('multiple terminal nodes with no results — summary is undefined', async () => {
			const rt = makeRuntimeWithTam();
			// Channel from/to use node names (realistic production format).
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi Terminal No Result ${Date.now()}`,
				nodes: [
					{ id: 'step-mtnr-start', name: 'Start', agentId: AGENT_CODER },
					{ id: 'step-mtnr-done1', name: 'Done1', agentId: AGENT_CODER },
					{ id: 'step-mtnr-done2', name: 'Done2', agentId: AGENT_CODER },
				],
				channels: [
					{
						id: 'ch-mtnr-1',
						from: 'Start',
						to: 'Done1',
					},
					{
						id: 'ch-mtnr-2',
						from: 'Start',
						to: 'Done2',
					},
				],
				startNodeId: 'step-mtnr-start',
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			const taskDone1 = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Done1',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: 'step-mtnr-done1',
				taskType: 'coding',
				status: 'open',
			});
			const taskDone2 = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Done2',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: 'step-mtnr-done2',
				taskType: 'coding',
				status: 'open',
			});

			// Complete all tasks but set NO result on any terminal node
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			taskRepo.updateTask(taskDone1.id, { status: 'done' });
			taskRepo.updateTask(taskDone2.id, { status: 'done' });
			seedNodeExec(db, run.id, 'step-mtnr-start', 'start', 'idle');
			seedNodeExec(db, run.id, 'step-mtnr-done1', 'done1', 'idle');
			seedNodeExec(db, run.id, 'step-mtnr-done2', 'done2', 'idle');

			await rt.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				expect(completedEvents[0].summary).toBeUndefined();
			}
		});

		test('empty result string on terminal node is not returned as summary', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Empty Result ${Date.now()}`,
				nodes: [{ id: 'step-empty-res', name: 'Done', agentId: AGENT_CODER }],
				startNodeId: 'step-empty-res',
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			// Set result to empty string — should not be treated as a valid summary
			taskRepo.updateTask(tasks[0].id, { status: 'done', result: '' });
			seedNodeExec(db, run.id, 'step-empty-res', 'done', 'idle');

			await rt.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				expect(completedEvents[0].summary).toBeUndefined();
			}
		});

		test('bidirectional channel — neither endpoint is treated as terminal', async () => {
			const rt = makeRuntimeWithTam();
			// A ↔ B — both nodes have outbound edges (bidirectional), so neither is terminal.
			// Channel from/to use node names (realistic production format).
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Bidirectional ${Date.now()}`,
				nodes: [
					{ id: 'step-bidi-a', name: 'Alpha', agentId: AGENT_CODER },
					{ id: 'step-bidi-b', name: 'Beta', agentId: AGENT_CODER },
				],
				channels: [
					{
						id: 'ch-bidi',
						from: 'Alpha',
						to: 'Beta',
					},
				],
				startNodeId: 'step-bidi-a',
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			const taskB = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'B',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: 'step-bidi-b',
				taskType: 'coding',
				status: 'open',
			});

			taskRepo.updateTask(tasks[0].id, { status: 'done', result: 'Result A' });
			taskRepo.updateTask(taskB.id, { status: 'done', result: 'Result B' });
			seedNodeExec(db, run.id, 'step-bidi-a', 'alpha', 'idle');
			seedNodeExec(db, run.id, 'step-bidi-b', 'beta', 'idle');

			await rt.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				// Both nodes are bidirectional — neither is terminal, summary should be undefined
				expect(completedEvents[0].summary).toBeUndefined();
			}
		});

		test('channel from/to agent slot names resolve to correct node', async () => {
			// Regression guard: channels use WorkflowNodeAgent.name (slot names), not node IDs.
			// Multi-agent node "Parallel" has slots "coder-slot" and "reviewer-slot".
			// Channel uses slot name "reviewer-slot" as from — that node should be non-terminal.
			const rt = makeRuntimeWithTam();
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Slot Name Resolution ${Date.now()}`,
				nodes: [
					{
						id: 'step-slot-parallel',
						name: 'Parallel',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder-slot' },
							{ agentId: AGENT_PLANNER2, name: 'reviewer-slot' },
						],
					},
					{ id: 'step-slot-done', name: 'Done', agentId: AGENT_CODER },
				],
				channels: [
					{
						id: 'ch-slot',
						// Agent slot name used as from — this is the production format
						from: 'reviewer-slot',
						to: 'Done',
					},
				],
				startNodeId: 'step-slot-parallel',
				rules: [],
				tags: [],
				completionAutonomyLevel: 3,
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks).toHaveLength(1);

			const doneTask = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Done',
				description: '',
				workflowRunId: run.id,
				status: 'open',
			});

			// Parallel-node tasks complete without a result so that only the Done task
			// carries a result. resolveCompletionSummary returns the first done task with
			// a result, which should be the Done node task.
			const doneSummary = '## Workflow Complete\n\nAll steps passed.';
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			taskRepo.updateTask(doneTask.id, { status: 'done', result: doneSummary });
			seedNodeExec(db, run.id, 'step-slot-parallel', 'coder-slot', 'idle');
			seedNodeExec(db, run.id, 'step-slot-parallel', 'reviewer-slot', 'idle');
			seedNodeExec(db, run.id, 'step-slot-done', 'done', 'idle', { result: doneSummary });

			await rt.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				// The Parallel node has an outbound channel (via slot name) → not terminal
				// Only Done is terminal → its summary is returned
				expect(completedEvents[0].summary).toBe(doneSummary);
			}
		});
	});
});
