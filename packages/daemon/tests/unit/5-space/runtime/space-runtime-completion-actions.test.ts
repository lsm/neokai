/**
 * SpaceRuntime — Completion Action Tests
 *
 * Tests resolveCompletionWithActions() behavior:
 *   - Workflows without completion actions use binary autonomy check (status = 'done' at level >= 2)
 *   - Completion actions auto-execute when space autonomy >= action.requiredLevel
 *   - Task pauses at 'review' with pendingActionIndex when autonomy < action.requiredLevel
 *   - All actions auto-executed → task goes to 'done' with 'auto_policy' approval
 *   - Script failure → task goes to 'failed' (not fire-and-forget)
 *   - completionActions survive DB round-trip (persisted in node config)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
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
import type { SpaceTask, SpaceWorkflowRun, SpaceWorkflow, Space } from '@neokai/shared';
import type { SpaceAutonomyLevel, CompletionAction } from '@neokai/shared';
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
	clear(): void {
		this.events.length = 0;
	}
}

// ---------------------------------------------------------------------------
// MockTaskAgentManager
// ---------------------------------------------------------------------------

class MockTaskAgentManager {
	readonly cancelledSessions: string[] = [];
	readonly spawnedExecutionSessions: string[] = [];

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
		const sessionId = `mock-session:${execution.id}`;
		this.spawnedExecutionSessions.push(sessionId);
		return sessionId;
	}
	async rehydrate(): Promise<void> {}
	cancelBySessionId(agentSessionId: string): void {
		this.cancelledSessions.push(agentSessionId);
	}
	async interruptBySessionId(_agentSessionId: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-completion-actions',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	// createTables provisions the base schema (notably sdk_messages, needed by
	// the thread-event emission path); runMigrations applies schema evolution.
	createTables(db);
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(
	db: BunDatabase,
	spaceId: string,
	workspacePath = '/tmp/workspace',
	autonomyLevel: SpaceAutonomyLevel = 1
): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, autonomy_level, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, autonomyLevel, Date.now(), Date.now());
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
// Workflow builder with completion actions support
// ---------------------------------------------------------------------------

function buildWorkflowWithActions(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	completionActions?: CompletionAction[]
): SpaceWorkflow {
	const endNodeId = 'end-node';
	return workflowManager.createWorkflow({
		spaceId,
		name: `Workflow ${Date.now()}`,
		description: '',
		nodes: [
			{
				id: endNodeId,
				name: 'End Node',
				agents: [{ agentId: 'agent-a', name: 'worker' }],
				completionActions,
			},
		],
		transitions: [],
		startNodeId: endNodeId,
		endNodeId,
		rules: [],
		tags: [],
	});
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SpaceRuntime — completion actions', () => {
	let db: BunDatabase;
	let dir: string;

	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let sink: MockNotificationSink;

	const SPACE_ID = 'space-ca-1';
	const AGENT_A = 'agent-a';

	function makeRuntime(extraConfig?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
		const config: SpaceRuntimeConfig = {
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo: new NodeExecutionRepository(db),
			notificationSink: sink,
			taskAgentManager: new MockTaskAgentManager() as unknown as TaskAgentManager,
			...extraConfig,
		};
		return new SpaceRuntime(config);
	}

	function setAutonomyLevel(level: SpaceAutonomyLevel): void {
		db.prepare(`UPDATE spaces SET autonomy_level = ? WHERE id = ?`).run(level, SPACE_ID);
	}

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpaceRow(db, SPACE_ID, dir, 1); // use test dir as workspace so scripts can run
		seedAgentRow(db, AGENT_A, SPACE_ID);

		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);

		spaceManager = new SpaceManager(db);
		sink = new MockNotificationSink();
	});

	afterEach(() => {
		try {
			db?.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	// ─── No completion actions (legacy behavior) ─────────────────────────

	test('no completion actions, autonomy >= 2 → task goes to done', async () => {
		setAutonomyLevel(2);
		const rt = makeRuntime();
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate end-node agent calling report_result — this is the new completion signal.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('done');
		expect(task.approvalSource).toBe('auto_policy');
		expect(task.completedAt).toBeDefined();
	});

	test('no completion actions, autonomy = 1 → task goes to review', async () => {
		const rt = makeRuntime();
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate end-node agent calling report_result — this is the new completion signal.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('review');
		expect(task.approvalSource).toBeNull();
	});

	// ─── With completion actions ─────────────────────────────────────────

	test('completion action with requiredLevel <= space level → auto-executes, task done', async () => {
		setAutonomyLevel(4);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'test-action',
				name: 'Test Action',
				type: 'script',
				requiredLevel: 4,
				script: 'echo "auto-executed"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate end-node agent calling report_result — this is the new completion signal.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('done');
		expect(task.approvalSource).toBe('auto_policy');
		expect(task.completedAt).toBeDefined();
		// Pending action metadata cleared
		expect(task.pendingActionIndex).toBeNull();
		expect(task.pendingCheckpointType).toBeNull();
	});

	test('completion action with requiredLevel > space level → task pauses at review', async () => {
		setAutonomyLevel(3);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'high-level-action',
				name: 'High Level Action',
				type: 'script',
				requiredLevel: 5,
				script: 'echo "needs approval"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate end-node agent calling report_result — this is the new completion signal.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('review');
		expect(task.pendingActionIndex).toBe(0);
		expect(task.pendingCheckpointType).toBe('completion_action');
	});

	test('multiple actions: first auto-executes, second pauses', async () => {
		setAutonomyLevel(3);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'action-low',
				name: 'Low-Level Action',
				type: 'script',
				requiredLevel: 2,
				script: 'echo "low level"',
			},
			{
				id: 'action-high',
				name: 'High-Level Action',
				type: 'script',
				requiredLevel: 5,
				script: 'echo "high level"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate end-node agent calling report_result — this is the new completion signal.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('review');
		// Paused at index 1 (the second action)
		expect(task.pendingActionIndex).toBe(1);
		expect(task.pendingCheckpointType).toBe('completion_action');
	});

	test('multiple actions all auto-execute at high autonomy → task done', async () => {
		setAutonomyLevel(5);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'action-1',
				name: 'Action 1',
				type: 'script',
				requiredLevel: 2,
				script: 'echo "one"',
			},
			{
				id: 'action-2',
				name: 'Action 2',
				type: 'script',
				requiredLevel: 4,
				script: 'echo "two"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate end-node agent calling report_result — this is the new completion signal.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('done');
		expect(task.approvalSource).toBe('auto_policy');
		expect(task.pendingActionIndex).toBeNull();
		expect(task.pendingCheckpointType).toBeNull();
	});

	// ─── Script failure behavior ────────────────────────────────────────

	test('completion action script failure → task fails', async () => {
		setAutonomyLevel(5);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'failing-action',
				name: 'Failing Action',
				type: 'script',
				requiredLevel: 3,
				script: 'echo "error" >&2; exit 1',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate end-node agent calling report_result — this is the new completion signal.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('blocked');
		expect(task.result).toContain('Failing Action');
	});

	test('completion action script non-zero exit → task fails', async () => {
		setAutonomyLevel(5);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'exit-action',
				name: 'Exit Action',
				type: 'script',
				requiredLevel: 2,
				script: 'exit 42',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate end-node agent calling report_result — this is the new completion signal.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('blocked');
		expect(task.result).toContain('Exit Action');
	});

	// ─── Resume from pendingActionIndex ─────────────────────────────────

	test('resumeCompletionActions executes pending action and transitions to done', async () => {
		setAutonomyLevel(3);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'action-low',
				name: 'Low-Level',
				type: 'script',
				requiredLevel: 2,
				script: 'echo "low"',
			},
			{
				id: 'action-high',
				name: 'High-Level',
				type: 'script',
				requiredLevel: 5,
				script: 'echo "high"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate end-node agent calling report_result — this is the new completion signal.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		// First tick: action-low auto-executes, action-high pauses
		await rt.executeTick();
		let task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('review');
		expect(task.pendingActionIndex).toBe(1);
		expect(task.pendingCheckpointType).toBe('completion_action');

		// Human approves → resume from pendingActionIndex
		const resumed = await rt.resumeCompletionActions(SPACE_ID, tasks[0].id);
		expect(resumed).not.toBeNull();
		expect(resumed!.status).toBe('done');
		expect(resumed!.approvalSource).toBe('human');
		expect(resumed!.pendingActionIndex).toBeNull();
		expect(resumed!.pendingCheckpointType).toBeNull();
	});

	test('resumeCompletionActions pauses again if next action also needs approval', async () => {
		setAutonomyLevel(2);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'action-1',
				name: 'Action 1',
				type: 'script',
				requiredLevel: 3,
				script: 'echo "1"',
			},
			{
				id: 'action-2',
				name: 'Action 2',
				type: 'script',
				requiredLevel: 4,
				script: 'echo "2"',
			},
			{
				id: 'action-3',
				name: 'Action 3',
				type: 'script',
				requiredLevel: 2,
				script: 'echo "3"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate end-node agent calling report_result — this is the new completion signal.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		// Tick: pauses at action-1 (requiredLevel 3, autonomy 2)
		await rt.executeTick();
		let task = taskRepo.getTask(tasks[0].id)!;
		expect(task.pendingActionIndex).toBe(0);

		// Human approves action-1 → executes it, then pauses at action-2 (index 1)
		const resumed = await rt.resumeCompletionActions(SPACE_ID, tasks[0].id);
		expect(resumed).not.toBeNull();
		expect(resumed!.status).toBe('review');
		expect(resumed!.pendingActionIndex).toBe(1);
		expect(resumed!.pendingCheckpointType).toBe('completion_action');
		// Stale approval from the previous cycle must be cleared so the UI does
		// not show the new pause as already-approved.
		expect(resumed!.approvedAt).toBeNull();
	});

	test('resumeCompletionActions returns null for task without pending checkpoint', async () => {
		setAutonomyLevel(2);
		const rt = makeRuntime();
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager);

		const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

		const result = await rt.resumeCompletionActions(SPACE_ID, tasks[0].id);
		expect(result).toBeNull();
	});

	// ─── Audit trail: approvalReason + thread events ─────────────────────

	test('resumeCompletionActions persists approvalReason on terminal done transition', async () => {
		setAutonomyLevel(3);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'action-high',
				name: 'Ship It',
				type: 'script',
				requiredLevel: 5,
				script: 'echo "shipped"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		// Tick pauses at the high-autonomy action awaiting human approval
		await rt.executeTick();
		expect(taskRepo.getTask(tasks[0].id)!.pendingCheckpointType).toBe('completion_action');

		// Resume with human-supplied rationale
		const resumed = await rt.resumeCompletionActions(SPACE_ID, tasks[0].id, {
			approvalReason: 'Looks good, ship it',
		});

		expect(resumed).not.toBeNull();
		expect(resumed!.status).toBe('done');
		expect(resumed!.approvalSource).toBe('human');
		expect(resumed!.approvalReason).toBe('Looks good, ship it');
	});

	test('resumeCompletionActions does NOT leak approvalReason onto intermediate pause', async () => {
		// When a resume executes one action and pauses again at a second, the reason
		// supplied for the first approval cycle must not persist onto the new pause —
		// the next human decision deserves its own audit entry.
		setAutonomyLevel(2);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'action-1',
				name: 'First',
				type: 'script',
				requiredLevel: 3,
				script: 'echo "1"',
			},
			{
				id: 'action-2',
				name: 'Second',
				type: 'script',
				requiredLevel: 4,
				script: 'echo "2"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();
		expect(taskRepo.getTask(tasks[0].id)!.pendingActionIndex).toBe(0);

		const resumed = await rt.resumeCompletionActions(SPACE_ID, tasks[0].id, {
			approvalReason: 'first-cycle reason',
		});

		expect(resumed!.status).toBe('review');
		expect(resumed!.pendingActionIndex).toBe(1);
		// The terminal-write path is the only place approvalReason is stamped on
		// this column; an intermediate re-pause must leave it untouched so the
		// UI does not mis-attribute the prior cycle's reason to the new pause.
		expect(resumed!.approvalReason).toBeNull();
	});

	test('resumeCompletionActions emits completion_action_executed notification once per action', async () => {
		setAutonomyLevel(3);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'a1',
				name: 'Approved Action',
				type: 'script',
				requiredLevel: 5,
				script: 'echo "ok"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();
		sink.clear(); // drop notifications emitted during the pause tick

		await rt.resumeCompletionActions(SPACE_ID, tasks[0].id, {
			approvalReason: 'ok to run',
		});

		const events = sink.events.filter((e) => e.kind === 'completion_action_executed');
		expect(events).toHaveLength(1);
		const event = events[0];
		if (event.kind !== 'completion_action_executed') throw new Error('narrow');
		expect(event.actionId).toBe('a1');
		expect(event.actionName).toBe('Approved Action');
		expect(event.approvedBy).toBe('human');
		expect(event.approvalReason).toBe('ok to run');
		expect(event.runId).toBe(run.id);
		expect(event.taskId).toBe(tasks[0].id);
	});

	test('auto-executed completion actions emit completion_action_executed with auto_policy', async () => {
		// Symmetry check: the notification must also fire on the auto-execute path
		// (no human approval), so the audit trail records every action regardless
		// of who authorized it.
		setAutonomyLevel(5);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'auto-1',
				name: 'Auto Action',
				type: 'script',
				requiredLevel: 2,
				script: 'echo "auto"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const events = sink.events.filter((e) => e.kind === 'completion_action_executed');
		expect(events.length).toBeGreaterThanOrEqual(1);
		const event = events[0];
		if (event.kind !== 'completion_action_executed') throw new Error('narrow');
		expect(event.actionId).toBe('auto-1');
		expect(event.approvedBy).toBe('auto_policy');
		expect(event.approvalReason).toBeNull();
		// The auto-execute notification must carry the owning task's id so
		// notification-sink consumers can bind the event to a task in the UI —
		// callers now thread canonicalTask.id into resolveCompletionWithActions.
		expect(event.taskId).toBe(tasks[0].id);
	});

	test('resumeCompletionActions writes thread event into the task agent session', async () => {
		setAutonomyLevel(3);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'thread-action',
				name: 'Thread Action',
				type: 'script',
				requiredLevel: 5,
				script: 'echo "t"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Attach a synthetic task-agent session id so emitTaskThreadEvent has a
		// target. Real deployments set this when the Task Agent spawns; we short-
		// circuit that for the test. The sdk_messages table has a FK to sessions,
		// so we must seed a session row to let the insert succeed.
		const taskAgentSessionId = `task-agent-${tasks[0].id}`;
		const nowIso = new Date().toISOString();
		db.prepare(
			`INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, type)
			 VALUES (?, 'Task Agent', ?, ?, 'active', '{}', '{}', 'space_task_agent')`
		).run(taskAgentSessionId, nowIso, nowIso);
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
			taskAgentSessionId,
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();
		await rt.resumeCompletionActions(SPACE_ID, tasks[0].id, {
			approvalReason: 'merge plz',
		});

		const rows = db
			.prepare(
				`SELECT sdk_message FROM sdk_messages
				  WHERE session_id = ? AND message_type = 'system' AND message_subtype = 'completion_action_executed'`
			)
			.all(taskAgentSessionId) as Array<{ sdk_message: string }>;

		expect(rows).toHaveLength(1);
		const payload = JSON.parse(rows[0].sdk_message);
		expect(payload.type).toBe('system');
		expect(payload.subtype).toBe('completion_action_executed');
		expect(payload.actionId).toBe('thread-action');
		expect(payload.actionName).toBe('Thread Action');
		expect(payload.approvedBy).toBe('human');
		expect(payload.approvalReason).toBe('merge plz');
	});

	// ─── completionActions DB persistence ────────────────────────────────

	test('completionActions survive DB round-trip via workflow repository', () => {
		const actions: CompletionAction[] = [
			{
				id: 'merge-pr',
				name: 'Merge PR',
				type: 'script',
				requiredLevel: 4,
				artifactType: 'pr',
				script: 'echo "merge"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		// Read back from DB
		const loaded = workflowManager.getWorkflow(workflow.id);
		expect(loaded).toBeDefined();

		const endNode = loaded!.nodes.find((n) => n.id === 'end-node');
		expect(endNode).toBeDefined();
		expect(endNode!.completionActions).toBeDefined();
		expect(endNode!.completionActions).toHaveLength(1);
		expect(endNode!.completionActions![0].id).toBe('merge-pr');
		expect(endNode!.completionActions![0].type).toBe('script');
		expect(endNode!.completionActions![0].requiredLevel).toBe(4);
		expect((endNode!.completionActions![0] as { script: string }).script).toBe('echo "merge"');
		expect(endNode!.completionActions![0].artifactType).toBe('pr');
	});

	test('workflow without completionActions loads clean (no undefined/null)', () => {
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager);

		const loaded = workflowManager.getWorkflow(workflow.id);
		const endNode = loaded!.nodes.find((n) => n.id === 'end-node');
		expect(endNode).toBeDefined();
		// completionActions should be absent, not null or undefined
		expect(endNode!.completionActions).toBeUndefined();
	});

	// ─── Awaiting-approval pause surface ─────────────────────────────────
	//
	// When a task pauses at a completion action because the space's autonomy
	// level is below the action's `requiredLevel`, the runtime must:
	//   1. populate `task.result` with a human-readable pause reason so read
	//      surfaces can explain *why* the task is awaiting review, while
	//      preserving the original agent output on `reportedSummary`; and
	//   2. emit a structured `task_awaiting_approval` event exactly once per
	//      distinct pause (so the Space Agent gets one notification, not one
	//      per tick).
	//
	// The auto-execute path (level sufficient) must not emit the event at all.

	test('pause at completion action populates result with pause-reason string', async () => {
		setAutonomyLevel(2);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'review-action',
				name: 'Merge PR',
				description: 'Merges the staged PR into main',
				type: 'script',
				requiredLevel: 4,
				script: 'echo "merge"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'original agent summary',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('review');
		expect(task.result).toBe('Awaiting approval: Merge PR (requires autonomy 4, space is at 2)');
		// Original agent output is still recoverable from reportedSummary
		expect(task.reportedSummary).toBe('original agent summary');
	});

	test('pause emits task_awaiting_approval event exactly once across ticks', async () => {
		setAutonomyLevel(2);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'approval-action',
				name: 'Deploy to prod',
				description: 'Promotes the staged build',
				type: 'script',
				requiredLevel: 5,
				script: 'echo "deploy"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		// Tick 1: task pauses, event fires
		await rt.executeTick();

		const firstPauseEvents = sink.events.filter((e) => e.kind === 'task_awaiting_approval');
		expect(firstPauseEvents).toHaveLength(1);
		const event = firstPauseEvents[0];
		if (event.kind !== 'task_awaiting_approval') throw new Error('narrowing');
		expect(event.spaceId).toBe(SPACE_ID);
		expect(event.taskId).toBe(tasks[0].id);
		expect(event.actionId).toBe('approval-action');
		expect(event.actionName).toBe('Deploy to prod');
		expect(event.actionDescription).toBe('Promotes the staged build');
		expect(event.actionType).toBe('script');
		expect(event.requiredLevel).toBe(5);
		expect(event.spaceLevel).toBe(2);
		expect(event.autonomyLevel).toBe(2);
		expect(typeof event.timestamp).toBe('string');

		// Tick 2: task still paused — event must NOT re-fire
		await rt.executeTick();
		const afterSecondTick = sink.events.filter((e) => e.kind === 'task_awaiting_approval');
		expect(afterSecondTick).toHaveLength(1);
	});

	test('auto-execute (level sufficient) does NOT emit task_awaiting_approval', async () => {
		setAutonomyLevel(5);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'auto-action',
				name: 'Auto Action',
				type: 'script',
				requiredLevel: 3,
				script: 'echo "ok"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('done');
		// No awaiting-approval event should have fired on the happy path
		expect(sink.events.filter((e) => e.kind === 'task_awaiting_approval')).toHaveLength(0);
	});

	test('resume re-pauses at next high-level action and emits a fresh event', async () => {
		setAutonomyLevel(2);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'first',
				name: 'First',
				type: 'script',
				requiredLevel: 3,
				script: 'echo "1"',
			},
			{
				id: 'second',
				name: 'Second',
				type: 'script',
				requiredLevel: 4,
				script: 'echo "2"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		// Pause at first action
		await rt.executeTick();
		const firstPause = sink.events.filter((e) => e.kind === 'task_awaiting_approval');
		expect(firstPause).toHaveLength(1);
		if (firstPause[0].kind !== 'task_awaiting_approval') throw new Error('narrowing');
		expect(firstPause[0].actionId).toBe('first');

		// Human approves → first action runs, re-pauses at second
		const resumed = await rt.resumeCompletionActions(SPACE_ID, tasks[0].id);
		expect(resumed!.status).toBe('review');
		expect(resumed!.pendingActionIndex).toBe(1);
		// Re-pause populates the pause-reason string for the new action
		expect(resumed!.result).toBe('Awaiting approval: Second (requires autonomy 4, space is at 2)');

		const allApprovalEvents = sink.events.filter((e) => e.kind === 'task_awaiting_approval');
		expect(allApprovalEvents).toHaveLength(2);
		if (allApprovalEvents[1].kind !== 'task_awaiting_approval') throw new Error('narrowing');
		expect(allApprovalEvents[1].actionId).toBe('second');
	});

	test('resume-to-done restores task.result from reportedSummary', async () => {
		setAutonomyLevel(3);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'only',
				name: 'Only Action',
				type: 'script',
				requiredLevel: 5,
				script: 'echo "ok"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'the real summary the agent produced',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();
		const paused = taskRepo.getTask(tasks[0].id)!;
		expect(paused.result).toContain('Awaiting approval');

		// Force autonomy high enough so resume succeeds (auto-executes the action)
		setAutonomyLevel(5);
		const resumed = await rt.resumeCompletionActions(SPACE_ID, tasks[0].id);
		expect(resumed!.status).toBe('done');
		expect(resumed!.result).toBe('the real summary the agent produced');
	});

	// ─── pendingAction read-path enrichment ──────────────────────────────

	test('enrichTaskWithPendingAction populates pendingAction metadata on paused task', async () => {
		setAutonomyLevel(2);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'merge-pr',
				name: 'Merge PR',
				description: 'Merges the staged PR',
				type: 'script',
				requiredLevel: 4,
				script: 'echo "merge"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('review');

		const { enrichTaskWithPendingAction } = await import(
			'../../../../src/lib/space/runtime/pending-action.ts'
		);
		const enriched = enrichTaskWithPendingAction(task, workflowRunRepo, workflowManager);
		expect(enriched.pendingAction).toBeDefined();
		expect(enriched.pendingAction).toEqual({
			id: 'merge-pr',
			name: 'Merge PR',
			description: 'Merges the staged PR',
			type: 'script',
			requiredLevel: 4,
		});
		// Ensure we did not leak the script body into the enriched shape
		expect((enriched.pendingAction as Record<string, unknown>)['script']).toBeUndefined();
	});

	test('enrichTaskWithPendingAction leaves non-paused tasks untouched', async () => {
		setAutonomyLevel(5);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'auto',
				name: 'Auto',
				type: 'script',
				requiredLevel: 2,
				script: 'echo "ok"',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'task complete',
		});
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('done');

		const { enrichTaskWithPendingAction } = await import(
			'../../../../src/lib/space/runtime/pending-action.ts'
		);
		const enriched = enrichTaskWithPendingAction(task, workflowRunRepo, workflowManager);
		expect(enriched.pendingAction).toBeUndefined();
	});
});
