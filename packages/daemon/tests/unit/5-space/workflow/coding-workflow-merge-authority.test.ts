/**
 * CODING_WORKFLOW — Merge-Authority Separation Tests (Task #41)
 *
 * End-to-end wiring tests that prove the two Task #41 bug fixes actually
 * plug into the runtime mechanisms:
 *
 * Bug A (unauthorized merge): A peer chat `send_message` with no `data`
 *   payload must NOT open the review-approval-gate. Only a structured
 *   `data: { approved: true }` write (by the `reviewer` agent) opens it.
 *   We exercise this against the real CODING_WORKFLOW gate + channel.
 *
 * Bug B (task lifecycle): When the Reviewer's approval gate opens and the
 *   Done node's `merge-pr` completion action has requiredLevel > space
 *   autonomy, the task must transition to `status: 'review'` with
 *   `pendingCheckpointType: 'completion_action'`. We assert this with the
 *   real MERGE_PR_COMPLETION_ACTION extracted from CODING_WORKFLOW's Done
 *   node.
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
import type {
	SpaceTask,
	SpaceWorkflowRun,
	SpaceWorkflow,
	Space,
	SpaceAutonomyLevel,
	CompletionAction,
	Gate,
} from '@neokai/shared';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { createNodeAgentToolHandlers } from '../../../../src/lib/space/tools/node-agent-tools.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
import { CODING_WORKFLOW } from '../../../../src/lib/space/workflows/built-in-workflows.ts';

// ---------------------------------------------------------------------------
// Helpers (trimmed copies of the patterns used by space-runtime-completion-actions.test.ts
// and node-agent-tools.test.ts — kept local so the two test suites stay independent).
// ---------------------------------------------------------------------------

class MockNotificationSink implements NotificationSink {
	readonly events: SpaceNotificationEvent[] = [];
	notify(event: SpaceNotificationEvent): Promise<void> {
		this.events.push(event);
		return Promise.resolve();
	}
}

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

function makeDb(prefix: string): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		prefix,
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
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

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, name, Date.now(), Date.now());
}

function seedNodeExec(
	db: BunDatabase,
	workflowRunId: string,
	workflowNodeId: string,
	agentName: string,
	status: string
): void {
	const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const now = Date.now();
	db.prepare(
		`INSERT OR REPLACE INTO node_executions
       (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
        agent_session_id, status, result, created_at, started_at,
        completed_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, NULL, ?)`
	).run(id, workflowRunId, workflowNodeId, agentName, status, now, now);
}

// ---------------------------------------------------------------------------
// Bug B — Task pauses at `review` when merge-pr requiredLevel > space level
// ---------------------------------------------------------------------------

describe('CODING_WORKFLOW Done node — merge-pr completion action (Task #41 Bug B)', () => {
	let db: BunDatabase;
	let dir: string;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let sink: MockNotificationSink;

	const SPACE_ID = 'space-ca-merge';
	const AGENT_ID = 'agent-coder';

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
		({ db, dir } = makeDb('test-coding-workflow-merge-authority'));
		seedSpaceRow(db, SPACE_ID, dir, 1);
		seedAgentRow(db, AGENT_ID, SPACE_ID, 'Coder');

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

	/** Extract the real merge-pr completion action from the CODING_WORKFLOW template. */
	function extractMergePrAction(): CompletionAction {
		const doneNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Done');
		expect(doneNode).toBeDefined();
		expect(doneNode!.completionActions).toBeDefined();
		expect(doneNode!.completionActions).toHaveLength(1);
		return doneNode!.completionActions![0];
	}

	/** Build a minimal workflow with a single end-node carrying the merge-pr action. */
	function buildWorkflowWithMergeAction(): SpaceWorkflow {
		const endNodeId = 'done-node';
		return workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Merge Authority ${Date.now()}`,
			description: '',
			nodes: [
				{
					id: endNodeId,
					name: 'Done',
					agents: [{ agentId: AGENT_ID, name: 'coder' }],
					completionActions: [extractMergePrAction()],
				},
			],
			transitions: [],
			startNodeId: endNodeId,
			endNodeId,
			rules: [],
			tags: [],
		});
	}

	test('merge-pr completion action in CODING_WORKFLOW has requiredLevel 4', () => {
		const action = extractMergePrAction();
		expect(action.id).toBe('merge-pr');
		// Below 4 means auto-execute at autonomy 3 (too permissive); 4+ forces pause.
		expect(action.requiredLevel).toBe(4);
		expect(action.type).toBe('script');
	});

	test('at autonomy 3, Done node task pauses at `review` awaiting human merge approval', async () => {
		setAutonomyLevel(3);
		const rt = makeRuntime();
		const workflow = buildWorkflowWithMergeAction();

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		// Simulate the Done node agent reporting done.
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'Reviewer approved; handing off to merge-pr completion action.',
		});
		seedNodeExec(db, run.id, 'done-node', 'coder', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		// Core Bug B contract: task moves to `review`, not directly to `done`.
		expect(task.status).toBe('review');
		// The pause reason is a pending completion action, not (e.g.) a leveled gate.
		expect(task.pendingCheckpointType).toBe('completion_action');
		expect(task.pendingActionIndex).toBe(0);
		// Must not have flipped to `done` — the merge hasn't run.
		expect(task.completedAt).toBeNull();
	});

	test('at autonomy 4, Done node task proceeds — merge action auto-executes (exits review)', async () => {
		setAutonomyLevel(4);
		const rt = makeRuntime();
		const workflow = buildWorkflowWithMergeAction();

		const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, {
			status: 'in_progress',
			reportedStatus: 'done',
			reportedSummary: 'Reviewer approved.',
		});
		seedNodeExec(db, run.id, 'done-node', 'coder', 'idle');

		await rt.executeTick();

		const task = taskRepo.getTask(tasks[0].id)!;
		// At autonomy >= requiredLevel the action auto-executes. It may succeed or
		// fail (depending on whether gh/jq are available in this sandbox), but it
		// MUST NOT leave the task parked at `review` with pendingCheckpointType set
		// — that would mean the pause logic ignored the autonomy level.
		expect(task.pendingCheckpointType).not.toBe('completion_action');
	});
});

// ---------------------------------------------------------------------------
// Bug A — send_message with chat only must NOT open review-approval-gate
// ---------------------------------------------------------------------------

describe('CODING_WORKFLOW review-approval-gate — send_message authorization (Task #41 Bug A)', () => {
	const spaceId = 'space-approval-gate';
	const workflowRunId = 'run-approval-gate';
	const nodeId = 'node-review';
	const reviewerSessionId = 'session-reviewer';
	const doneSessionId = 'session-done';

	let db: BunDatabase;
	let dir: string;
	let gateDataRepo: GateDataRepository;
	let nodeExecutionRepo: NodeExecutionRepository;
	let taskRepo: SpaceTaskRepository;

	function extractReviewApprovalGate(): Gate {
		const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate');
		expect(gate).toBeDefined();
		return gate!;
	}

	function buildReviewToDoneWorkflow(): SpaceWorkflow {
		const approvalGate = extractReviewApprovalGate();
		return {
			id: 'wf-review-to-done',
			spaceId,
			name: 'Coding Workflow fragment',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [
				{
					id: 'ch-review-done',
					from: 'reviewer',
					to: 'Done',
					gateId: approvalGate.id,
				},
			],
			gates: [approvalGate],
		};
	}

	function seedSpaceAndPeers(): void {
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
       allowed_models, session_ids, slug, status, created_at, updated_at)
       VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
		).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());

		db.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
         VALUES (?, ?, 'wf-review-to-done', '', 'pending', ?, ?)`
		).run(workflowRunId, spaceId, Date.now(), Date.now());

		// Seed peer tasks: reviewer (self) and Done.
		const seedTask = (agentName: string, sessionId: string): void => {
			const taskId = `task-${agentName}-${Math.random().toString(36).slice(2)}`;
			const now = Date.now();
			db.exec('PRAGMA foreign_keys = OFF');
			db.prepare(
				`INSERT INTO space_tasks
           (id, space_id, task_number, title, description, status, priority, result,
            workflow_run_id, depends_on, task_agent_session_id, created_at, updated_at)
           VALUES (?, ?,
             (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?),
             ?, '', 'in_progress', 'normal', NULL, ?, '[]', ?, ?, ?)`
			).run(taskId, spaceId, spaceId, agentName, workflowRunId, sessionId, now, now);
			db.exec('PRAGMA foreign_keys = ON');
			nodeExecutionRepo.createOrIgnore({
				workflowRunId,
				workflowNodeId: nodeId,
				agentName,
				agentSessionId: sessionId,
				status: 'in_progress',
			});
		};

		seedTask('reviewer', reviewerSessionId);
		seedTask('Done', doneSessionId);
	}

	beforeEach(() => {
		({ db, dir } = makeDb('test-coding-workflow-approval-gate'));
		gateDataRepo = new GateDataRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		taskRepo = new SpaceTaskRepository(db);
		seedSpaceAndPeers();
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

	test('review-approval-gate exists and has reviewer-only writers (sanity check)', () => {
		const gate = extractReviewApprovalGate();
		const approved = gate.fields!.find((f) => f.name === 'approved')!;
		expect(approved.writers).toEqual(['reviewer']);
		expect(gate.requiredLevel).toBeGreaterThanOrEqual(4);
	});

	test('reviewer sending chat-only send_message does NOT open review-approval-gate', async () => {
		const workflow = buildReviewToDoneWorkflow();
		const channelResolver = new ChannelResolver(workflow.channels ?? []);
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo,
			workflowRunId,
			workflowChannels: channelResolver.getChannels(),
			messageInjector: async () => {},
		});
		// Create a parent task so send_message has context.
		const parentTask = taskRepo.createTask({
			spaceId,
			title: 'Parent',
			description: '',
			status: 'in_progress',
		});
		const handlers = createNodeAgentToolHandlers({
			mySessionId: reviewerSessionId,
			myAgentName: 'reviewer',
			taskId: parentTask.id,
			spaceId,
			channelResolver,
			workflowRunId,
			workflowNodeId: nodeId,
			nodeExecutionRepo,
			agentMessageRouter,
			workflow,
			gateDataRepo,
		});

		// Reviewer sends a pure chat message — "approved" is just text, not data.
		const result = await handlers.send_message({
			target: 'Done',
			message: 'looks good to me, approved',
		});
		const data = JSON.parse(result.content[0].text);

		// No gateWrite in the response — the gate was not touched.
		expect(data.gateWrite).toBeUndefined();
		// And the gate data row is empty (no `approved` field set).
		const record = gateDataRepo.get(workflowRunId, 'review-approval-gate');
		expect(record?.data?.approved).toBeUndefined();
	});

	test('reviewer sending send_message with data={approved:true} opens review-approval-gate', async () => {
		const workflow = buildReviewToDoneWorkflow();
		const channelResolver = new ChannelResolver(workflow.channels ?? []);
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo,
			workflowRunId,
			workflowChannels: channelResolver.getChannels(),
			messageInjector: async () => {},
		});
		const parentTask = taskRepo.createTask({
			spaceId,
			title: 'Parent',
			description: '',
			status: 'in_progress',
		});
		const handlers = createNodeAgentToolHandlers({
			mySessionId: reviewerSessionId,
			myAgentName: 'reviewer',
			taskId: parentTask.id,
			spaceId,
			channelResolver,
			workflowRunId,
			workflowNodeId: nodeId,
			nodeExecutionRepo,
			agentMessageRouter,
			workflow,
			gateDataRepo,
		});

		const result = await handlers.send_message({
			target: 'Done',
			message: 'approving via structured data',
			data: { approved: true },
		});
		const data = JSON.parse(result.content[0].text);

		// Gate was written — the approval is recorded as structured data.
		expect(data.gateWrite).toBeDefined();
		expect(data.gateWrite.gateId).toBe('review-approval-gate');
		expect(data.gateWrite.gateOpen).toBe(true);
		const record = gateDataRepo.get(workflowRunId, 'review-approval-gate');
		expect(record?.data?.approved).toBe(true);
	});

	test('non-reviewer agent cannot open review-approval-gate even with data={approved:true}', async () => {
		// Simulate a coder trying to self-approve by impersonating a write. The
		// gate's `writers: ['reviewer']` must reject the write silently (the gate
		// tool authorizes writes by agent name, not by target channel).
		const workflow = buildReviewToDoneWorkflow();
		// coder → Done channel (bypasses reviewer role entirely)
		workflow.channels = [
			{
				id: 'ch-coder-done',
				from: 'coder',
				to: 'Done',
				gateId: 'review-approval-gate',
			},
		];
		const channelResolver = new ChannelResolver(workflow.channels ?? []);
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo,
			workflowRunId,
			workflowChannels: channelResolver.getChannels(),
			messageInjector: async () => {},
		});
		const parentTask = taskRepo.createTask({
			spaceId,
			title: 'Parent',
			description: '',
			status: 'in_progress',
		});
		// Seed a coder peer task + executions.
		const coderSessionId = 'session-coder-for-auth-test';
		db.exec('PRAGMA foreign_keys = OFF');
		db.prepare(
			`INSERT INTO space_tasks
         (id, space_id, task_number, title, description, status, priority, result,
          workflow_run_id, depends_on, task_agent_session_id, created_at, updated_at)
         VALUES (?, ?,
           (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?),
           'coder', '', 'in_progress', 'normal', NULL, ?, '[]', ?, ?, ?)`
		).run(
			'task-coder-auth',
			spaceId,
			spaceId,
			workflowRunId,
			coderSessionId,
			Date.now(),
			Date.now()
		);
		db.exec('PRAGMA foreign_keys = ON');
		nodeExecutionRepo.createOrIgnore({
			workflowRunId,
			workflowNodeId: nodeId,
			agentName: 'coder',
			agentSessionId: coderSessionId,
			status: 'in_progress',
		});

		const handlers = createNodeAgentToolHandlers({
			mySessionId: coderSessionId,
			myAgentName: 'coder',
			taskId: parentTask.id,
			spaceId,
			channelResolver,
			workflowRunId,
			workflowNodeId: nodeId,
			nodeExecutionRepo,
			agentMessageRouter,
			workflow,
			gateDataRepo,
		});

		const result = await handlers.send_message({
			target: 'Done',
			message: 'self-approving',
			data: { approved: true },
		});
		const body = JSON.parse(result.content[0].text);

		// The gate filter drops unauthorized fields — `approved` must not land in gate data.
		const record = gateDataRepo.get(workflowRunId, 'review-approval-gate');
		expect(record?.data?.approved).toBeUndefined();
		// Even if a gateWrite row is emitted, the gate must remain closed because
		// no authorized writer has supplied the required field.
		if (body.gateWrite) {
			expect(body.gateWrite.gateOpen).toBe(false);
		}
	});
});
