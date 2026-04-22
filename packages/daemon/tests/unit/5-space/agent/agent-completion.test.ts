/**
 * Tests for Task 2.4 (Query Completion State Capability) — post-M71 schema.
 *
 * Covers:
 *   - Migration 71 schema: open/done/blocked/cancelled/archived statuses, labels column
 *   - list_peers: completionState per peer from node_executions
 *   - list_group_members: completionState per member from node_executions
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import {
	createNodeAgentToolHandlers,
	type NodeAgentToolsConfig,
} from '../../../../src/lib/space/tools/node-agent-tools.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import {
	createTaskAgentToolHandlers,
	type SubSessionFactory,
	type SubSessionState,
	type TaskAgentToolsConfig,
} from '../../../../src/lib/space/tools/task-agent-tools.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
import type { Space } from '@neokai/shared';

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

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedSpaceTask(
	db: BunDatabase,
	spaceId: string,
	workflowRunId: string,
	_workflowNodeId: string,
	agentName: string,
	status: string = 'open',
	result: string | null = null
): string {
	const id = `task-${Math.random().toString(36).slice(2)}`;
	const now = Date.now();
	// Use agentName as title so nodeCompletionState.agentName reflects the agent name
	db.exec('PRAGMA foreign_keys = OFF');
	db.prepare(
		`INSERT INTO space_tasks
         (id, space_id, task_number, title, description, status, priority,
          workflow_run_id, result, depends_on, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?), ?, '', ?, 'normal', ?, ?, '[]', ?, ?)`
	).run(id, spaceId, spaceId, agentName, status, workflowRunId, result, now, now);
	db.exec('PRAGMA foreign_keys = ON');
	return id;
}

function seedNodeExecution(
	nodeExecutionRepo: NodeExecutionRepository,
	workflowRunId: string,
	workflowNodeId: string,
	agentName: string,
	status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled' = 'in_progress',
	result: string | null = null,
	agentSessionId: string | null = null
): string {
	const execution = nodeExecutionRepo.create({
		workflowRunId,
		workflowNodeId,
		agentName,
		agentSessionId,
		status,
	});
	nodeExecutionRepo.update(execution.id, {
		status,
		result,
		agentSessionId,
	});
	return execution.id;
}

function seedWorkflowRun(db: BunDatabase, spaceId: string): string {
	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflow = workflowRepo.createWorkflow({
		spaceId,
		name: 'Test Workflow',
		description: '',
		nodes: [],
		transitions: [],
		startNodeId: '',
		rules: [],
		completionAutonomyLevel: 3,
	});
	const runRepo = new SpaceWorkflowRunRepository(db);
	const run = runRepo.createRun({
		spaceId,
		workflowId: workflow.id,
		title: 'Test Run',
	});
	return run.id;
}

function makeSpace(spaceId: string): Space {
	return {
		id: spaceId,
		workspacePath: '/tmp/test-workspace',
		name: `Space ${spaceId}`,
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeMockSessionFactory(): SubSessionFactory {
	const states = new Map<string, SubSessionState>();
	const callbacks = new Map<string, () => Promise<void>>();
	return {
		async create(): Promise<string> {
			const id = `session-${Math.random().toString(36).slice(2)}`;
			states.set(id, { isProcessing: true, isComplete: false });
			return id;
		},
		getProcessingState(sessionId: string): SubSessionState | null {
			return states.get(sessionId) ?? null;
		},
		onComplete(sessionId: string, callback: () => Promise<void>): void {
			callbacks.set(sessionId, callback);
		},
	};
}

// ---------------------------------------------------------------------------
// Tests: Migration 71 schema (post-M71 space_tasks schema)
// ---------------------------------------------------------------------------

describe('Migration 51 — rename slot_role → agent_name, add completion_summary', () => {
	let db: BunDatabase;

	beforeEach(() => {
		db = makeDb();
	});

	afterEach(() => {
		db.close();
	});

	test('space_tasks has labels column after migration', () => {
		expect(() => db.prepare(`SELECT labels FROM space_tasks LIMIT 1`).all()).not.toThrow();
	});

	test('space_tasks does not have agent_name column after M71 migration', () => {
		expect(() => db.prepare(`SELECT agent_name FROM space_tasks LIMIT 1`).all()).toThrow();
	});

	test('space_tasks does not have completion_summary column after M71 migration', () => {
		expect(() => db.prepare(`SELECT completion_summary FROM space_tasks LIMIT 1`).all()).toThrow();
	});

	test('SpaceTaskRepository creates tasks with open status by default', () => {
		const spaceId = 'space-m71-test';
		seedSpaceRow(db, spaceId);
		const repo = new SpaceTaskRepository(db);
		const task = repo.createTask({
			spaceId,
			title: 'Test Task',
			description: 'desc',
		});
		expect(task.status).toBe('open');

		const fetched = repo.getTask(task.id);
		expect(fetched?.status).toBe('open');
	});

	test('SpaceTaskRepository stores and retrieves result', () => {
		const spaceId = 'space-m71-result-test';
		seedSpaceRow(db, spaceId);
		const repo = new SpaceTaskRepository(db);
		const task = repo.createTask({
			spaceId,
			title: 'Test Task',
			description: 'desc',
		});
		repo.updateTask(task.id, { result: 'Task finished successfully' });

		const fetched = repo.getTask(task.id);
		expect(fetched?.result).toBe('Task finished successfully');
	});
});

// ---------------------------------------------------------------------------
// Tests: list_peers — completion state (node-agent-tools.ts)
// ---------------------------------------------------------------------------

describe('list_peers — completion state via SpaceTaskRepository', () => {
	let db: BunDatabase;
	let spaceId: string;
	let spaceTaskRepo: SpaceTaskRepository;
	let nodeExecutionRepo: NodeExecutionRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	const coderSessionId = 'session-coder-cs';

	beforeEach(() => {
		db = makeDb();
		spaceId = 'space-lp-cs-test';
		seedSpaceRow(db, spaceId);

		spaceTaskRepo = new SpaceTaskRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		workflowRunRepo = new SpaceWorkflowRunRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	function makeConfig(overrides: Partial<NodeAgentToolsConfig> = {}): NodeAgentToolsConfig {
		const workflowRunId = overrides.workflowRunId ?? '';
		const channelResolver = overrides.channelResolver ?? new ChannelResolver([]);
		return {
			mySessionId: coderSessionId,
			myAgentName: 'coder',
			taskId: 'lp-cs-task',
			spaceId,
			channelResolver,
			workflowRunId,
			workflowNodeId: '',
			nodeExecutionRepo,
			agentMessageRouter:
				overrides.agentMessageRouter ??
				new AgentMessageRouter({
					nodeExecutionRepo,
					workflowRunId,
					workflowChannels: channelResolver.getChannels(),
					messageInjector: async () => {},
				}),
			...overrides,
		};
	}

	test('list_peers shows nodeCompletionState for all tasks on the node', async () => {
		const nodeId = 'node-ncs';
		const workflowRunId = seedWorkflowRun(db, spaceId);
		seedNodeExecution(
			nodeExecutionRepo,
			workflowRunId,
			nodeId,
			'coder',
			'in_progress',
			null,
			coderSessionId
		);
		seedNodeExecution(
			nodeExecutionRepo,
			workflowRunId,
			nodeId,
			'reviewer',
			'done',
			'Done',
			'session-reviewer-cs'
		);

		const handlers = createNodeAgentToolHandlers(
			makeConfig({ workflowRunId, workflowNodeId: nodeId })
		);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.nodeCompletionState).toHaveLength(2);
		const reviewerState = data.nodeCompletionState.find(
			(s: { agentName: string }) => s.agentName === 'reviewer'
		);
		expect(reviewerState?.taskStatus).toBe('done');
		expect(reviewerState?.completionSummary).toBe('Done');
	});

	test('list_peers returns empty nodeCompletionState when no tasks on node', async () => {
		const workflowRunId = seedWorkflowRun(db, spaceId);

		const handlers = createNodeAgentToolHandlers(
			makeConfig({ workflowRunId, workflowNodeId: 'node-empty' })
		);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.nodeCompletionState).toHaveLength(0);
		expect(data.peers).toHaveLength(0);
	});

	test('list_peers includes peers from tasks with active sub-sessions', async () => {
		const nodeId = 'node-lp-cs';
		const workflowRunId = seedWorkflowRun(db, spaceId);
		seedNodeExecution(
			nodeExecutionRepo,
			workflowRunId,
			nodeId,
			'coder',
			'in_progress',
			null,
			coderSessionId
		);
		seedNodeExecution(
			nodeExecutionRepo,
			workflowRunId,
			nodeId,
			'reviewer',
			'done',
			'Review passed',
			'session-reviewer-cs'
		);

		const handlers = createNodeAgentToolHandlers(
			makeConfig({ workflowRunId, workflowNodeId: nodeId })
		);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		const reviewerPeer = data.peers.find((p: { agentName: string }) => p.agentName === 'reviewer');
		expect(reviewerPeer).toBeDefined();
		expect(reviewerPeer.completionState.taskStatus).toBe('done');
		expect(reviewerPeer.completionState.completionSummary).toBe('Review passed');
		expect(reviewerPeer.completionState.agentName).toBe('reviewer');
	});
});

// ---------------------------------------------------------------------------
// Tests: list_group_members — completion state (task-agent-tools.ts)
// ---------------------------------------------------------------------------

describe('list_group_members — completion state via SpaceTaskRepository', () => {
	let db: BunDatabase;
	let spaceId: string;
	let taskRepo: SpaceTaskRepository;
	let nodeExecutionRepo: NodeExecutionRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	const mainTaskId = 'main-task-lgm';

	beforeEach(() => {
		db = makeDb();
		spaceId = 'space-lgm-cs-test';
		seedSpaceRow(db, spaceId);

		taskRepo = new SpaceTaskRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		workflowRunRepo = new SpaceWorkflowRunRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	function makeConfig(
		workflowRunId: string,
		overrides: Partial<TaskAgentToolsConfig> = {}
	): TaskAgentToolsConfig {
		const agentRepo = new SpaceAgentRepository(db);
		const agentManager = new SpaceAgentManager(agentRepo);
		const workflowRepo = new SpaceWorkflowRepository(db);
		const workflowManager = new SpaceWorkflowManager(workflowRepo);
		const spaceManager = new SpaceManager(db);
		const taskManager = new SpaceTaskManager(db, spaceId);

		return {
			taskId: mainTaskId,
			space: makeSpace(spaceId),
			workflowRunId,
			workspacePath: '/tmp/test-workspace',
			workflowManager,
			taskRepo,
			workflowRunRepo,
			nodeExecutionRepo,
			agentManager,
			taskManager,
			sessionFactory: makeMockSessionFactory(),
			messageInjector: async () => {},
			onSubSessionComplete: async () => {},
			...overrides,
		};
	}

	test('list_group_members includes nodeCompletionState for all tasks in run', async () => {
		const nodeId = 'node-lgm-ncs';
		const workflowRunId = seedWorkflowRun(db, spaceId);
		seedNodeExecution(
			nodeExecutionRepo,
			workflowRunId,
			nodeId,
			'coder',
			'in_progress',
			null,
			'session-coder-lgm'
		);
		seedNodeExecution(
			nodeExecutionRepo,
			workflowRunId,
			nodeId,
			'reviewer',
			'done',
			'Done',
			'session-reviewer-lgm'
		);

		const handlers = createTaskAgentToolHandlers(makeConfig(workflowRunId));
		const result = await handlers.list_group_members({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(Array.isArray(data.nodeCompletionState)).toBe(true);
		expect(data.nodeCompletionState).toHaveLength(2);
	});

	test('list_group_members returns empty members when no tasks have active sub-sessions', async () => {
		const workflowRunId = seedWorkflowRun(db, spaceId);

		const handlers = createTaskAgentToolHandlers(makeConfig(workflowRunId));
		const result = await handlers.list_group_members({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.members).toHaveLength(0);
	});

	test('list_group_members includes completionState for tasks with active sub-sessions', async () => {
		const nodeId = 'node-lgm-cs';
		const workflowRunId = seedWorkflowRun(db, spaceId);
		seedNodeExecution(
			nodeExecutionRepo,
			workflowRunId,
			nodeId,
			'reviewer',
			'done',
			'Approved',
			'session-reviewer-lgm'
		);

		const handlers = createTaskAgentToolHandlers(makeConfig(workflowRunId));
		const result = await handlers.list_group_members({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		// list_group_members uses role: 'agent' for all members (task-agent-tools post-M71)
		expect(data.members).toHaveLength(1);
		const reviewerMember = data.members[0];
		expect(reviewerMember).toBeDefined();
		expect(reviewerMember.completionState).not.toBeNull();
		expect(reviewerMember.completionState.taskStatus).toBe('done');
		expect(reviewerMember.completionState.completionSummary).toBe('Approved');
	});
});
