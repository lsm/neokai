/**
 * Tests for Task 2.2 (Migration 51) and Task 2.4 (Query Completion State Capability).
 *
 * Covers:
 *   - Migration 51: rename slot_role → agent_name, add completion_summary to space_tasks
 *   - list_peers: completionState per peer from space_tasks
 *   - list_group_members: completionState per member from space_tasks
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { runMigration51 } from '../../../src/storage/schema/migrations.ts';
import { SpaceSessionGroupRepository } from '../../../src/storage/repositories/space-session-group-repository.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import {
	createStepAgentToolHandlers,
	type StepAgentToolsConfig,
} from '../../../src/lib/space/tools/step-agent-tools.ts';
import {
	createTaskAgentToolHandlers,
	type SubSessionFactory,
	type SubSessionState,
	type TaskAgentToolsConfig,
} from '../../../src/lib/space/tools/task-agent-tools.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import type { Space } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-agent-completion',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, Date.now(), Date.now());
}

function seedAgentRow(
	db: BunDatabase,
	agentId: string,
	spaceId: string,
	name: string,
	role: string
): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
     config, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, name, role, Date.now(), Date.now());
}

function seedSpaceTask(
	db: BunDatabase,
	spaceId: string,
	workflowRunId: string,
	workflowNodeId: string,
	agentName: string,
	status: string = 'pending',
	completionSummary: string | null = null
): string {
	const id = `task-${Math.random().toString(36).slice(2)}`;
	const now = Date.now();
	// Disable FK for seeding test data — workflow_node_id points to an arbitrary test node ID
	db.exec('PRAGMA foreign_keys = OFF');
	db.prepare(
		`INSERT INTO space_tasks
         (id, space_id, title, description, status, priority, agent_name, completion_summary,
          workflow_run_id, workflow_node_id, depends_on, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, 'normal', ?, ?, ?, ?, '[]', ?, ?)`
	).run(
		id,
		spaceId,
		`Task for ${agentName}`,
		status,
		agentName,
		completionSummary,
		workflowRunId,
		workflowNodeId,
		now,
		now
	);
	db.exec('PRAGMA foreign_keys = ON');
	return id;
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
	});
	const runRepo = new SpaceWorkflowRunRepository(db);
	const run = runRepo.createRun({
		spaceId,
		workflowId: workflow.id,
		title: 'Test Run',
		triggeredBy: 'test',
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
// Tests: Migration 51
// ---------------------------------------------------------------------------

describe('Migration 51 — rename slot_role → agent_name, add completion_summary', () => {
	let db: BunDatabase;
	let dir: string;

	beforeEach(() => {
		const result = makeDb();
		db = result.db;
		dir = result.dir;
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test('space_tasks has agent_name column after migration', () => {
		// Migration runs via runMigrations in makeDb(); verify agent_name exists
		expect(() => db.prepare(`SELECT agent_name FROM space_tasks LIMIT 1`).all()).not.toThrow();
	});

	test('space_tasks has completion_summary column after migration', () => {
		expect(() =>
			db.prepare(`SELECT completion_summary FROM space_tasks LIMIT 1`).all()
		).not.toThrow();
	});

	test('space_tasks does not have slot_role column after migration', () => {
		expect(() => db.prepare(`SELECT slot_role FROM space_tasks LIMIT 1`).all()).toThrow();
	});

	test('migration 51 is idempotent — runs twice without error', () => {
		expect(() => runMigration51(db)).not.toThrow();
		expect(() => runMigration51(db)).not.toThrow();
	});

	test('SpaceTaskRepository stores and retrieves agentName', () => {
		const spaceId = 'space-m51-test';
		seedSpaceRow(db, spaceId);
		const repo = new SpaceTaskRepository(db);
		const task = repo.createTask({
			spaceId,
			title: 'Test Task',
			description: 'desc',
			agentName: 'reviewer',
		});
		expect(task.agentName).toBe('reviewer');

		const fetched = repo.getTask(task.id);
		expect(fetched?.agentName).toBe('reviewer');
	});

	test('SpaceTaskRepository stores and retrieves completionSummary', () => {
		const spaceId = 'space-m51-cs-test';
		seedSpaceRow(db, spaceId);
		const repo = new SpaceTaskRepository(db);
		const task = repo.createTask({
			spaceId,
			title: 'Test Task',
			description: 'desc',
		});
		repo.updateTask(task.id, { completionSummary: 'Task finished successfully' });

		const fetched = repo.getTask(task.id);
		expect(fetched?.completionSummary).toBe('Task finished successfully');
	});
});

// ---------------------------------------------------------------------------
// Tests: list_peers — completion state (step-agent-tools.ts)
// ---------------------------------------------------------------------------

describe('list_peers — completion state via SpaceTaskRepository', () => {
	let db: BunDatabase;
	let dir: string;
	let spaceId: string;
	let sessionGroupRepo: SpaceSessionGroupRepository;
	let spaceTaskRepo: SpaceTaskRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let groupId: string;
	const coderSessionId = 'session-coder-cs';
	const reviewerSessionId = 'session-reviewer-cs';

	beforeEach(() => {
		const result = makeDb();
		db = result.db;
		dir = result.dir;
		spaceId = 'space-lp-cs-test';
		seedSpaceRow(db, spaceId);

		sessionGroupRepo = new SpaceSessionGroupRepository(db);
		spaceTaskRepo = new SpaceTaskRepository(db);
		workflowRunRepo = new SpaceWorkflowRunRepository(db);

		const group = sessionGroupRepo.createGroup({
			spaceId,
			name: 'task:lp-cs-task',
			taskId: 'lp-cs-task',
		});
		groupId = group.id;

		sessionGroupRepo.addMember(groupId, 'session-ta-cs', {
			role: 'task-agent',
			status: 'active',
		});
		sessionGroupRepo.addMember(groupId, coderSessionId, {
			role: 'coder',
			status: 'active',
			agentId: 'agent-coder',
		});
		sessionGroupRepo.addMember(groupId, reviewerSessionId, {
			role: 'reviewer',
			status: 'active',
			agentId: 'agent-reviewer',
		});
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function makeConfig(overrides: Partial<StepAgentToolsConfig> = {}): StepAgentToolsConfig {
		return {
			mySessionId: coderSessionId,
			myRole: 'coder',
			taskId: 'lp-cs-task',
			workflowRunId: '',
			workflowNodeId: '',
			sessionGroupRepo,
			spaceTaskRepo,
			getGroupId: () => groupId,
			workflowRunRepo,
			messageInjector: async () => {},
			...overrides,
		};
	}

	test('list_peers includes completionState for peer with matching agentName task', async () => {
		const nodeId = 'node-lp-cs';
		const workflowRunId = seedWorkflowRun(db, spaceId);
		seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'reviewer', 'completed', 'Review passed');

		const handlers = createStepAgentToolHandlers(
			makeConfig({ workflowRunId, workflowNodeId: nodeId })
		);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		const reviewerPeer = data.peers.find((p: { role: string }) => p.role === 'reviewer');
		expect(reviewerPeer).toBeDefined();
		expect(reviewerPeer.completionState).not.toBeNull();
		expect(reviewerPeer.completionState.taskStatus).toBe('completed');
		expect(reviewerPeer.completionState.completionSummary).toBe('Review passed');
		expect(reviewerPeer.completionState.agentName).toBe('reviewer');
	});

	test('list_peers shows nodeCompletionState for all tasks on the node', async () => {
		const nodeId = 'node-ncs';
		const workflowRunId = seedWorkflowRun(db, spaceId);
		seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'coder', 'in_progress', null);
		seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'reviewer', 'completed', 'Done');

		const handlers = createStepAgentToolHandlers(
			makeConfig({ workflowRunId, workflowNodeId: nodeId })
		);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.nodeCompletionState).toHaveLength(2);
		const reviewerState = data.nodeCompletionState.find(
			(s: { agentName: string }) => s.agentName === 'reviewer'
		);
		expect(reviewerState?.taskStatus).toBe('completed');
		expect(reviewerState?.completionSummary).toBe('Done');
	});

	test('list_peers returns null completionState when no tasks on node', async () => {
		const workflowRunId = seedWorkflowRun(db, spaceId);

		const handlers = createStepAgentToolHandlers(
			makeConfig({ workflowRunId, workflowNodeId: 'node-empty' })
		);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.nodeCompletionState).toHaveLength(0);
		for (const peer of data.peers) {
			expect(peer.completionState).toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: list_group_members — completion state (task-agent-tools.ts)
// ---------------------------------------------------------------------------

describe('list_group_members — completion state via SpaceTaskRepository', () => {
	let db: BunDatabase;
	let dir: string;
	let spaceId: string;
	let sessionGroupRepo: SpaceSessionGroupRepository;
	let spaceTaskRepo: SpaceTaskRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let groupId: string;
	const taskAgentSessionId = 'session-ta-lgm';
	const coderSessionId = 'session-coder-lgm';
	const reviewerSessionId = 'session-reviewer-lgm';
	const mainTaskId = 'main-task-lgm';

	beforeEach(() => {
		const result = makeDb();
		db = result.db;
		dir = result.dir;
		spaceId = 'space-lgm-cs-test';
		seedSpaceRow(db, spaceId);
		seedAgentRow(db, 'agent-coder-lgm', spaceId, 'Coder', 'coder');

		sessionGroupRepo = new SpaceSessionGroupRepository(db);
		spaceTaskRepo = new SpaceTaskRepository(db);
		taskRepo = new SpaceTaskRepository(db);
		workflowRunRepo = new SpaceWorkflowRunRepository(db);

		const group = sessionGroupRepo.createGroup({
			spaceId,
			name: `task:${mainTaskId}`,
			taskId: mainTaskId,
		});
		groupId = group.id;

		sessionGroupRepo.addMember(groupId, taskAgentSessionId, {
			role: 'task-agent',
			status: 'active',
		});
		sessionGroupRepo.addMember(groupId, coderSessionId, {
			role: 'coder',
			status: 'active',
			agentId: 'agent-coder-lgm',
		});
		sessionGroupRepo.addMember(groupId, reviewerSessionId, {
			role: 'reviewer',
			status: 'active',
		});
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
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
		const runtime = new SpaceRuntime({
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
		});

		return {
			taskId: mainTaskId,
			space: makeSpace(spaceId),
			workflowRunId,
			workspacePath: '/tmp/test-workspace',
			runtime,
			workflowManager,
			taskRepo,
			workflowRunRepo,
			agentManager,
			taskManager,
			sessionFactory: makeMockSessionFactory(),
			messageInjector: async () => {},
			onSubSessionComplete: async () => {},
			sessionGroupRepo,
			getGroupId: () => groupId,
			...overrides,
		};
	}

	test('list_group_members includes completionState per member from space_tasks', async () => {
		const nodeId = 'node-lgm-cs';
		const workflowRunId = seedWorkflowRun(db, spaceId);
		// Set the run's currentNodeId so list_group_members can find tasks for this node
		workflowRunRepo.updateRun(workflowRunId, { currentNodeId: nodeId });
		seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'reviewer', 'completed', 'Approved');

		const handlers = createTaskAgentToolHandlers(makeConfig(workflowRunId));
		const result = await handlers.list_group_members({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		const reviewerMember = data.members.find((m: { role: string }) => m.role === 'reviewer');
		expect(reviewerMember).toBeDefined();
		expect(reviewerMember.completionState).not.toBeNull();
		expect(reviewerMember.completionState.taskStatus).toBe('completed');
		expect(reviewerMember.completionState.completionSummary).toBe('Approved');
	});

	test('list_group_members includes nodeCompletionState', async () => {
		const nodeId = 'node-lgm-ncs';
		const workflowRunId = seedWorkflowRun(db, spaceId);
		workflowRunRepo.updateRun(workflowRunId, { currentNodeId: nodeId });
		seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'coder', 'in_progress', null);
		seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'reviewer', 'completed', 'Done');

		const handlers = createTaskAgentToolHandlers(makeConfig(workflowRunId));
		const result = await handlers.list_group_members({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(Array.isArray(data.nodeCompletionState)).toBe(true);
		expect(data.nodeCompletionState).toHaveLength(2);
	});

	test('list_group_members returns null completionState when no tasks match', async () => {
		const workflowRunId = seedWorkflowRun(db, spaceId);

		const handlers = createTaskAgentToolHandlers(makeConfig(workflowRunId));
		const result = await handlers.list_group_members({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		for (const member of data.members) {
			expect(member.completionState).toBeNull();
		}
	});
});
