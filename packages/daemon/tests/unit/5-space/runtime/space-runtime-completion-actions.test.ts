/**
 * SpaceRuntime — Completion Action Tests
 *
 * Tests resolveCompletionWithActions() behavior:
 *   - Workflows without completion actions use binary autonomy check (status = 'done' at level >= 2)
 *   - Completion actions auto-execute when space autonomy >= action.requiredLevel
 *   - Task pauses at 'review' with pendingActionIndex when autonomy < action.requiredLevel
 *   - All actions auto-executed → task goes to 'done' with 'auto_policy' approval
 *   - completionActions survive DB round-trip (persisted in node config)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
	const WORKSPACE = '/tmp/ca-ws';
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
		seedSpaceRow(db, SPACE_ID, WORKSPACE, 1); // default level 1, overridden per test
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
		taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
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
		taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
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
		taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
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
		taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
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
		taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
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
		taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('done');
		expect(task.approvalSource).toBe('auto_policy');
		expect(task.pendingActionIndex).toBeNull();
		expect(task.pendingCheckpointType).toBeNull();
	});

	// ─── Script failure behavior (fire-and-forget) ─────────────────────

	test('completion action script failure → task still transitions to done', async () => {
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
		taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		// Completion actions are best-effort — script failure does not block task completion
		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('done');
		expect(task.approvalSource).toBe('auto_policy');
		expect(task.pendingActionIndex).toBeNull();
	});

	test('completion action script timeout → task still transitions to done', async () => {
		setAutonomyLevel(5);
		const rt = makeRuntime();

		const actions: CompletionAction[] = [
			{
				id: 'timeout-action',
				name: 'Timeout Action',
				type: 'script',
				requiredLevel: 2,
				// The script sleeps, but executeCompletionAction has a 120s timeout.
				// We can't wait 120s in a test, so test with a script that exits non-zero
				// to exercise the same code path (both log a warning and continue).
				script: 'exit 42',
			},
		];
		const workflow = buildWorkflowWithActions(SPACE_ID, workflowManager, actions);

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
		seedNodeExec(db, run.id, 'end-node', 'worker', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		expect(task.status).toBe('done');
		expect(task.approvalSource).toBe('auto_policy');
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
});
