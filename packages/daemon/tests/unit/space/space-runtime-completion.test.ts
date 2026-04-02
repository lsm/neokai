/**
 * SpaceRuntime Completion Detection & Status Transition Tests
 *
 * Tests the tick loop integration with CompletionDetector:
 *   - Status transition in_progress → completed sets completedAt
 *   - Multi-node workflows with mixed terminal statuses
 *   - needs_attention / completed / cancelled runs are skipped
 *   - Pending-but-blocked via workflow channels
 *   - No duplicate notifications across ticks
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
import type { SpaceWorkflow, SpaceTask, SpaceWorkflowRun, Space } from '@neokai/shared';
import type { TaskAgentManager } from '../../../src/lib/space/runtime/task-agent-manager.ts';
import { NodeExecutionRepository } from '../../../src/storage/repositories/node-execution-repository.ts';

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

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-space-runtime-completion',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/workspace'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

function buildLinearWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	nodes: Array<{ id: string; name: string; agentId: string }>,
	channels?: Array<{ from: string; to: string | string[] }>
): SpaceWorkflow {
	return workflowManager.createWorkflow({
		spaceId,
		name: `Workflow ${Date.now()}-${Math.random()}`,
		description: '',
		nodes,
		transitions: [],
		startNodeId: nodes[0].id,
		rules: [],
		tags: [],
		channels,
	});
}

function seedNodeExec(
	db: BunDatabase,
	workflowRunId: string,
	workflowNodeId: string,
	agentName: string,
	status: string
): string {
	const id = `exec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const now = Date.now();
	db.prepare(
		`INSERT OR REPLACE INTO node_executions
		     (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
		      agent_session_id, status, result, created_at, started_at,
		      completed_at, updated_at)
		     VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, NULL, ?)`
	).run(id, workflowRunId, workflowNodeId, agentName, status, now, now);
	return id;
}

// ---------------------------------------------------------------------------
// MockTaskAgentManager
// ---------------------------------------------------------------------------

class MockTaskAgentManager {
	isTaskAgentAlive(_taskId: string): boolean {
		return false;
	}

	isSpawning(_taskId: string): boolean {
		return false;
	}

	async spawnTaskAgent(
		_task: SpaceTask,
		_space: Space,
		_workflow: SpaceWorkflow | null,
		_run: SpaceWorkflowRun | null
	): Promise<string> {
		return 'mock-session';
	}

	async rehydrate(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SpaceRuntime — completion detection & status transitions', () => {
	let db: BunDatabase;
	let dir: string;

	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let sink: MockNotificationSink;

	let nodeExecutionRepo: NodeExecutionRepository;

	const SPACE_ID = 'space-cd-1';
	const WORKSPACE = '/tmp/cd-ws';
	const AGENT_A = 'agent-cd-a';
	const AGENT_B = 'agent-cd-b';
	const AGENT_C = 'agent-cd-c';

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
		({ db, dir } = makeDb());

		seedSpaceRow(db, SPACE_ID, WORKSPACE);
		seedAgentRow(db, AGENT_A, SPACE_ID);
		seedAgentRow(db, AGENT_B, SPACE_ID);
		seedAgentRow(db, AGENT_C, SPACE_ID);

		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);

		spaceManager = new SpaceManager(db);
		sink = new MockNotificationSink();
		nodeExecutionRepo = new NodeExecutionRepository(db);
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
	// completedAt timestamp
	// -------------------------------------------------------------------------

	describe('completedAt timestamp', () => {
		test('sets completedAt when CompletionDetector marks run as completed', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-ts', name: 'Step', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Verify run starts without completedAt
			const freshRun = workflowRunRepo.getRun(run.id);
			expect(freshRun?.completedAt).toBeNull();

			taskRepo.updateTask(tasks[0].id, { status: 'done' });

			// Create matching node_execution record for CompletionDetector
			seedNodeExec(db, run.id, 'step-ts', 'agent', 'done');

			// Capture time before tick to verify completedAt is recent
			const beforeTick = Date.now();
			await rt.executeTick();

			const completedRun = workflowRunRepo.getRun(run.id);
			expect(completedRun?.status).toBe('done');
			expect(completedRun?.completedAt).toBeDefined();
			expect(typeof completedRun?.completedAt).toBe('number');
			// Verify completedAt is set to a recent timestamp (within the tick's execution window)
			expect(completedRun!.completedAt!).toBeGreaterThanOrEqual(beforeTick);
			expect(completedRun!.completedAt!).toBeLessThanOrEqual(Date.now() + 100);
		});
	});

	// -------------------------------------------------------------------------
	// Multi-node workflow completion
	// -------------------------------------------------------------------------

	describe('multi-node workflow completion', () => {
		test('multi-node with all tasks completed → run completes', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'node-cd-1', name: 'Plan', agentId: AGENT_B },
				{ id: 'node-cd-2', name: 'Code', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks).toHaveLength(1); // Only start node activated

			// Complete the start node task
			taskRepo.updateTask(tasks[0].id, { status: 'done' });

			// Manually activate the second node and complete it
			// (In production this would be done by ChannelRouter.activateNode)
			const taskManager = rt.getTaskManagerForSpace(SPACE_ID);
			const secondTask = await taskManager.createTask({
				title: 'Code',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: 'node-cd-2',
				taskType: 'coding',
				agentName: 'coder',
				status: 'done',
			});

			// Create node_execution records for CompletionDetector
			seedNodeExec(db, run.id, 'node-cd-1', 'agent', 'done');
			seedNodeExec(db, run.id, 'node-cd-2', 'coder', 'done');

			await rt.executeTick();

			const completedRun = workflowRunRepo.getRun(run.id);
			expect(completedRun?.status).toBe('done');
			expect(completedRun?.completedAt).toBeDefined();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				expect(completedEvents[0].runId).toBe(run.id);
				expect(completedEvents[0].status).toBe('done');
			}
		});

		test('multi-node with mixed terminal statuses (completed + cancelled) → run completes', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'node-mix-1', name: 'Plan', agentId: AGENT_B },
				{ id: 'node-mix-2', name: 'Code', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// First node completed
			taskRepo.updateTask(tasks[0].id, { status: 'done' });

			// Second node cancelled
			const taskManager = rt.getTaskManagerForSpace(SPACE_ID);
			await taskManager.createTask({
				title: 'Code',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: 'node-mix-2',
				taskType: 'coding',
				agentName: 'coder',
				status: 'cancelled',
			});

			// Create node_execution records for CompletionDetector
			seedNodeExec(db, run.id, 'node-mix-1', 'agent', 'done');
			seedNodeExec(db, run.id, 'node-mix-2', 'coder', 'cancelled');

			await rt.executeTick();

			const completedRun = workflowRunRepo.getRun(run.id);
			expect(completedRun?.status).toBe('done');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
		});

		test('multi-node with one task still in_progress → run does NOT complete', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'node-ip-1', name: 'Plan', agentId: AGENT_B },
				{ id: 'node-ip-2', name: 'Code', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// First node completed
			taskRepo.updateTask(tasks[0].id, { status: 'done' });

			// Second node in progress
			const taskManager = rt.getTaskManagerForSpace(SPACE_ID);
			await taskManager.createTask({
				title: 'Code',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: 'node-ip-2',
				taskType: 'coding',
				agentName: 'coder',
				status: 'in_progress',
			});

			// Create node_execution records — one done, one still in_progress
			seedNodeExec(db, run.id, 'node-ip-1', 'agent', 'done');
			seedNodeExec(db, run.id, 'node-ip-2', 'coder', 'in_progress');

			await rt.executeTick();

			const runAfter = workflowRunRepo.getRun(run.id);
			expect(runAfter?.status).toBe('in_progress');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// Tick loop early returns for terminal/paused run states
	// -------------------------------------------------------------------------

	describe('tick loop early returns', () => {
		test('processRunTick skips run in needs_attention state', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-na-skip', name: 'Step', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			// Escalate to needs_attention
			workflowRunRepo.transitionStatus(run.id, 'blocked');

			// Set task to completed — normally this would trigger completion
			taskRepo.updateTask(tasks[0].id, { status: 'done' });

			await rt.executeTick();

			// Run should still be needs_attention (not completed) because
			// processRunTick returns early for needs_attention runs
			const runAfter = workflowRunRepo.getRun(run.id);
			expect(runAfter?.status).toBe('blocked');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(0);
		});

		test('processRunTick skips run in completed state', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-done-skip', name: 'Step', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Complete the task and let tick mark run as completed
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, 'step-done-skip', 'agent', 'done');
			await rt.executeTick();

			expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
			expect(rt.executorCount).toBe(0);

			// Reset the sink to track events after first tick
			sink.clear();

			// Second tick — no events, no errors
			await rt.executeTick();
			expect(sink.events).toHaveLength(0);
		});

		test('processRunTick skips run in cancelled state', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-cancel-skip', name: 'Step', agentId: AGENT_A },
			]);

			const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Cancel via status transition
			workflowRunRepo.transitionStatus(run.id, 'cancelled');

			sink.clear();
			await rt.executeTick();

			// No notifications for cancelled runs (cleanupTerminalExecutors
			// does NOT emit for cancelled, only for completed)
			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(0);

			// Executor cleaned up
			expect(rt.executorCount).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Status transition lifecycle via tick loop
	// -------------------------------------------------------------------------

	describe('status transition lifecycle', () => {
		test('in_progress → completed is a valid transition via CompletionDetector', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-lifecycle', name: 'Step', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(run.status).toBe('in_progress');

			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, 'step-lifecycle', 'agent', 'done');
			await rt.executeTick();

			const runAfter = workflowRunRepo.getRun(run.id);
			expect(runAfter?.status).toBe('done');
		});

		test('completed run cannot transition again — subsequent ticks are no-ops', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-Immutable', name: 'Step', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, 'step-Immutable', 'agent', 'done');
			await rt.executeTick();

			expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
			expect(sink.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);

			// Multiple additional ticks
			await rt.executeTick();
			await rt.executeTick();
			await rt.executeTick();

			// Still exactly one completed event
			expect(sink.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
		});

		test('needs_attention run does not auto-complete even when all tasks become terminal', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-na-no-auto', name: 'Step', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Move to needs_attention
			workflowRunRepo.transitionStatus(run.id, 'blocked');

			// All tasks terminal
			taskRepo.updateTask(tasks[0].id, { status: 'done' });

			await rt.executeTick();

			// Run stays blocked — processRunTick returns early
			const runAfter = workflowRunRepo.getRun(run.id);
			expect(runAfter?.status).toBe('blocked');
			expect(runAfter?.completedAt).toBeNull();
		});

		test('needs_attention → in_progress → completed lifecycle via resume', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-resume', name: 'Step', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Step 1: escalate to needs_attention
			workflowRunRepo.transitionStatus(run.id, 'blocked');
			expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');

			// Step 2: human resolves → resume to in_progress
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');

			// Step 3: complete all tasks
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, 'step-resume', 'agent', 'done');
			await rt.executeTick();

			// Step 4: run should now be completed
			const finalRun = workflowRunRepo.getRun(run.id);
			expect(finalRun?.status).toBe('done');
			expect(finalRun?.completedAt).toBeDefined();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// Pending-but-blocked via workflow channels in tick loop context
	// -------------------------------------------------------------------------

	describe('pending-but-blocked via workflow channels', () => {
		test('run completes when all active tasks are done (channel topology guard removed in M71)', async () => {
			// NOTE: The channel-based pending-node-activation guard was removed as part of the M71
			// schema migration (which dropped workflow_node_id from space_tasks).
			// A replacement guard using endNodeId will be added in a subsequent task.
			// This test verifies the CURRENT behavior: a run with all tasks done completes,
			// even if a channel target node was never activated.
			const rt = makeRuntimeWithTam();

			// Create a workflow with channels: Plan → Code
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Channeled Workflow ${Date.now()}`,
				description: '',
				nodes: [
					{
						id: 'chan-plan',
						name: 'planner',
						agents: [{ agentId: AGENT_B, name: 'Planner' }],
					},
					{
						id: 'chan-code',
						name: 'coder',
						agents: [{ agentId: AGENT_A, name: 'Coder' }],
					},
				],
				startNodeId: 'chan-plan',
				tags: [],
				channels: [{ from: 'planner', to: 'coder', direction: 'one-way' }],
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks).toHaveLength(1); // Only start node

			// Complete the only node-agent task
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, 'chan-plan', 'Planner', 'done');

			await rt.executeTick();

			// Run DOES complete because all tasks are done (channel guard was removed in M71).
			// When endNodeId-based completion guard is implemented, this test should be updated.
			const runAfter = workflowRunRepo.getRun(run.id);
			expect(runAfter?.status).toBe('done');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
		});

		test('all channels satisfied — completion proceeds normally', async () => {
			const rt = makeRuntimeWithTam();

			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Full Channel Workflow ${Date.now()}`,
				description: '',
				nodes: [
					{ id: 'full-plan', name: 'planner', agentId: AGENT_B },
					{ id: 'full-code', name: 'coder', agentId: AGENT_A },
				],
				startNodeId: 'full-plan',
				rules: [],
				tags: [],
				transitions: [],
				channels: [{ from: 'planner', to: 'coder', direction: 'one-way' }],
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Complete start node
			taskRepo.updateTask(tasks[0].id, { status: 'done' });

			// Manually activate second node and complete it
			const taskManager = rt.getTaskManagerForSpace(SPACE_ID);
			await taskManager.createTask({
				title: 'Code',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: 'full-code',
				taskType: 'coding',
				agentName: 'coder',
				status: 'done',
			});

			// Create node_execution records for CompletionDetector
			seedNodeExec(db, run.id, 'full-plan', 'agent', 'done');
			seedNodeExec(db, run.id, 'full-code', 'coder', 'done');

			await rt.executeTick();

			const completedRun = workflowRunRepo.getRun(run.id);
			expect(completedRun?.status).toBe('done');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
		});

		test('no channels on workflow — completion only checks task statuses', async () => {
			const rt = makeRuntimeWithTam();

			// Workflow with NO channels
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'no-chan-1', name: 'Plan', agentId: AGENT_B },
				{ id: 'no-chan-2', name: 'Code', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Complete start node only — second node never activated
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, 'no-chan-1', 'agent', 'done');

			await rt.executeTick();

			// Without channels, CompletionDetector has no guard —
			// only task statuses matter. Start node is terminal → complete.
			const completedRun = workflowRunRepo.getRun(run.id);
			expect(completedRun?.status).toBe('done');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
		});

		test('wildcard channel does not block completion', async () => {
			const rt = makeRuntimeWithTam();

			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Wildcard Channel ${Date.now()}`,
				description: '',
				nodes: [{ id: 'wc-plan', name: 'planner', agentId: AGENT_B }],
				startNodeId: 'wc-plan',
				rules: [],
				tags: [],
				transitions: [],
				channels: [{ from: 'planner', to: '*', direction: 'one-way' }],
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			seedNodeExec(db, run.id, 'wc-plan', 'planner', 'done');

			await rt.executeTick();

			const completedRun = workflowRunRepo.getRun(run.id);
			expect(completedRun?.status).toBe('done');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// Multi-agent parallel node completion
	// -------------------------------------------------------------------------

	describe('multi-agent parallel node', () => {
		test('all agents in parallel node complete → run completes', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Parallel Complete ${Date.now()}`,
				description: '',
				nodes: [
					{
						id: 'par-node',
						name: 'Parallel Step',
						agents: [
							{ agentId: AGENT_A, name: 'coder' },
							{ agentId: AGENT_B, name: 'planner' },
							{ agentId: AGENT_C, name: 'general' },
						],
					},
				],
				startNodeId: 'par-node',
				rules: [],
				tags: [],
				transitions: [],
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks).toHaveLength(3);

			// Complete all three tasks with different terminal statuses
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			taskRepo.updateTask(tasks[1].id, { status: 'done' });
			taskRepo.updateTask(tasks[2].id, { status: 'cancelled' });

			// Create node_execution records for CompletionDetector
			seedNodeExec(db, run.id, 'par-node', 'coder', 'done');
			seedNodeExec(db, run.id, 'par-node', 'planner', 'done');
			seedNodeExec(db, run.id, 'par-node', 'general', 'cancelled');

			await rt.executeTick();

			const completedRun = workflowRunRepo.getRun(run.id);
			expect(completedRun?.status).toBe('done');
			expect(completedRun?.completedAt).toBeDefined();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
		});

		test('one agent in parallel node still in_progress → run stays in_progress', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Parallel Partial ${Date.now()}`,
				description: '',
				nodes: [
					{
						id: 'par-partial',
						name: 'Parallel Step',
						agents: [
							{ agentId: AGENT_A, name: 'coder' },
							{ agentId: AGENT_B, name: 'planner' },
						],
					},
				],
				startNodeId: 'par-partial',
				rules: [],
				tags: [],
				transitions: [],
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			taskRepo.updateTask(tasks[1].id, { status: 'in_progress' });

			// Create node_execution records — one done, one still in_progress
			seedNodeExec(db, run.id, 'par-partial', 'coder', 'done');
			seedNodeExec(db, run.id, 'par-partial', 'planner', 'in_progress');

			await rt.executeTick();

			const runAfter = workflowRunRepo.getRun(run.id);
			expect(runAfter?.status).toBe('in_progress');

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(0);
		});

		test('agents finish at different ticks — completion detected on final tick', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Staggered Complete ${Date.now()}`,
				description: '',
				nodes: [
					{
						id: 'stag-node',
						name: 'Staggered Step',
						agents: [
							{ agentId: AGENT_A, name: 'coder' },
							{ agentId: AGENT_B, name: 'planner' },
						],
					},
				],
				startNodeId: 'stag-node',
				rules: [],
				tags: [],
				transitions: [],
			});

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Create node_execution records for both agents (start non-terminal)
			const exec1Id = seedNodeExec(db, run.id, 'stag-node', 'coder', 'in_progress');
			const exec2Id = seedNodeExec(db, run.id, 'stag-node', 'planner', 'in_progress');

			// Tick 1: first agent completes
			taskRepo.updateTask(tasks[0].id, { status: 'done' });
			db.prepare('UPDATE node_executions SET status = ? WHERE id = ?').run('done', exec1Id);
			await rt.executeTick();
			expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
			expect(sink.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);

			// Tick 2: second agent completes
			taskRepo.updateTask(tasks[1].id, { status: 'done' });
			db.prepare('UPDATE node_executions SET status = ? WHERE id = ?').run('done', exec2Id);
			await rt.executeTick();

			// Now the run should be completed
			expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
			expect(sink.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);

			// Tick 3: no duplicate
			await rt.executeTick();
			expect(sink.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// Dedup cleanup on terminal executor removal
	// -------------------------------------------------------------------------

	describe('dedup cleanup on completion', () => {
		test('dedup entries are cleaned up when executor is removed on completion', async () => {
			const rt = makeRuntimeWithTam();
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-dedup-clean', name: 'Step', agentId: AGENT_A },
			]);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			const taskId = tasks[0].id;
			// M71: dedup key uses 'blocked' (renamed from 'needs_attention')
			const dedupKey = `${taskId}:blocked`;

			// Empty dedup set at start
			expect(rt.getNotifiedTaskSet().has(dedupKey)).toBe(false);

			// Set task to blocked, tick to add dedup key
			// M71: 'error' field removed from SpaceTask; task status 'blocked' triggers notification
			taskRepo.updateTask(taskId, { status: 'blocked' });
			await rt.executeTick();
			// M71: event kind is 'task_blocked' (renamed from 'task_needs_attention')
			expect(sink.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
			// Dedup entry was added
			expect(rt.getNotifiedTaskSet().has(dedupKey)).toBe(true);

			// Now resolve the task and complete it
			taskRepo.updateTask(taskId, { status: 'done' });
			// Create node_execution record in terminal status for CompletionDetector
			seedNodeExec(db, run.id, 'step-dedup-clean', 'agent', 'done');
			await rt.executeTick();

			// Run should be completed
			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			// Dedup entry was removed when executor was cleaned up
			expect(rt.getNotifiedTaskSet().has(dedupKey)).toBe(false);
		});
	});
});
