/**
 * Unit tests for the agent-to-task creation flow (Task 2.1)
 *
 * Verifies the full end-to-end flow:
 * - Space agent creates tasks via create_standalone_task tool
 * - Created tasks have all expected fields
 * - Tasks appear in list_tasks results
 * - Workflow association is set when agent uses start_workflow_run
 * - Tasks created via workflow are filterable by workflow_run_id
 *
 * Happy paths covered: 3 (agent creates task), 4 (task visibility in list),
 * 10 (artifacts/fields), 12 (user interaction fields)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { NodeExecutionRepository } from '../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import { createSpaceAgentToolHandlers } from '../../../src/lib/space/tools/space-agent-tools.ts';
import type { SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB + space setup helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-agent-task-flow',
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

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, name, Date.now(), Date.now());
}

function buildSingleStepWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	agentId: string,
	name: string,
	tags: string[] = [],
	description = ''
): SpaceWorkflow {
	const stepId = `step-${Math.random().toString(36).slice(2)}`;
	return workflowManager.createWorkflow({
		spaceId,
		name,
		description,
		nodes: [{ id: stepId, name: 'Work', agentId }],
		transitions: [],
		startNodeId: stepId,
		rules: [],
		tags,
	});
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

interface TestCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	agentId: string;
	workflowManager: SpaceWorkflowManager;
	workflowRunRepo: SpaceWorkflowRunRepository;
	taskRepo: SpaceTaskRepository;
	taskManager: SpaceTaskManager;
	agentManager: SpaceAgentManager;
	runtime: SpaceRuntime;
	nodeExecutionRepo: NodeExecutionRepository;
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-flow-test';
	const workspacePath = '/tmp/test-workspace';

	seedSpaceRow(db, spaceId, workspacePath);

	const agentId = 'agent-coder-1';
	seedAgentRow(db, agentId, spaceId, 'Coder');

	const agentRepo = new SpaceAgentRepository(db);
	const agentManager = new SpaceAgentManager(agentRepo);

	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflowManager = new SpaceWorkflowManager(workflowRepo);

	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const nodeExecutionRepo = new NodeExecutionRepository(db);
	const taskRepo = new SpaceTaskRepository(db);
	const spaceManager = new SpaceManager(db);

	const runtime = new SpaceRuntime({
		db,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		workflowRunRepo,
		taskRepo,
		nodeExecutionRepo,
	});

	const taskManager = new SpaceTaskManager(db, spaceId);

	return {
		db,
		dir,
		spaceId,
		agentId,
		workflowManager,
		workflowRunRepo,
		taskRepo,
		taskManager,
		agentManager,
		runtime,
		nodeExecutionRepo,
	};
}

function makeHandlers(ctx: TestCtx) {
	return createSpaceAgentToolHandlers({
		spaceId: ctx.spaceId,
		runtime: ctx.runtime,
		workflowManager: ctx.workflowManager,
		taskRepo: ctx.taskRepo,
		workflowRunRepo: ctx.workflowRunRepo,
		taskManager: ctx.taskManager,
		spaceAgentManager: ctx.agentManager,
		nodeExecutionRepo: ctx.nodeExecutionRepo,
	});
}

/** Helper to parse a tool result into a JS object */
function parseResult(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Agent-to-task creation: all expected fields
// ---------------------------------------------------------------------------

describe('Agent-to-task creation flow — field completeness', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('create_standalone_task returns task with all expected SpaceTask fields', async () => {
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'Implement user authentication',
			description: 'Add JWT-based authentication to the API',
			priority: 'high',
		});
		const parsed = parseResult(result);
		expect(parsed.success).toBe(true);

		const task = parsed.task;
		// Required identity fields
		expect(task.id).toBeDefined();
		expect(typeof task.id).toBe('string');
		expect(task.spaceId).toBe(ctx.spaceId);
		expect(typeof task.taskNumber).toBe('number');
		expect(task.taskNumber).toBeGreaterThanOrEqual(1);

		// Content fields
		expect(task.title).toBe('Implement user authentication');
		expect(task.description).toBe('Add JWT-based authentication to the API');

		// Status and priority
		expect(task.status).toBe('open');
		expect(task.priority).toBe('high');

		// Default collection fields
		expect(task.labels).toEqual([]);
		expect(task.dependsOn).toEqual([]);

		// Null fields for standalone tasks (no workflow association)
		expect(task.result).toBeNull();
		expect(task.workflowRunId ?? null).toBeNull();
		expect(task.createdByTaskId ?? null).toBeNull();

		// Timestamps
		expect(typeof task.createdAt).toBe('number');
		expect(task.createdAt).toBeGreaterThan(0);
	});

	test('create_standalone_task defaults priority to normal when not specified', async () => {
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'Default priority task',
			description: 'Should default to normal priority',
		});
		const task = parseResult(result).task;
		expect(task.priority).toBe('normal');
	});

	test('create_standalone_task assigns incrementing taskNumber per space', async () => {
		const handlers = makeHandlers(ctx);
		const r1 = await handlers.create_standalone_task({
			title: 'First',
			description: 'desc 1',
		});
		const r2 = await handlers.create_standalone_task({
			title: 'Second',
			description: 'desc 2',
		});
		const r3 = await handlers.create_standalone_task({
			title: 'Third',
			description: 'desc 3',
		});

		const t1 = parseResult(r1).task;
		const t2 = parseResult(r2).task;
		const t3 = parseResult(r3).task;

		expect(t2.taskNumber).toBe(t1.taskNumber + 1);
		expect(t3.taskNumber).toBe(t2.taskNumber + 1);
	});

	test('created task is persisted to DB and matches returned fields', async () => {
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'Persisted task',
			description: 'Check DB round-trip',
			priority: 'urgent',
		});
		const returned = parseResult(result).task;

		// Re-read from repository
		const stored = ctx.taskRepo.getTask(returned.id);
		expect(stored).not.toBeNull();
		expect(stored!.id).toBe(returned.id);
		expect(stored!.spaceId).toBe(returned.spaceId);
		expect(stored!.taskNumber).toBe(returned.taskNumber);
		expect(stored!.title).toBe(returned.title);
		expect(stored!.description).toBe(returned.description);
		expect(stored!.status).toBe(returned.status);
		expect(stored!.priority).toBe(returned.priority);
		expect(stored!.createdAt).toBe(returned.createdAt);
	});

	test('each priority value is accepted and stored correctly', async () => {
		const priorities = ['low', 'normal', 'high', 'urgent'] as const;
		const handlers = makeHandlers(ctx);

		for (const priority of priorities) {
			const result = await handlers.create_standalone_task({
				title: `${priority} priority task`,
				description: `Testing ${priority}`,
				priority,
			});
			const task = parseResult(result).task;
			expect(task.priority).toBe(priority);
		}
	});
});

// ---------------------------------------------------------------------------
// Agent creates task → task appears in list_tasks
// ---------------------------------------------------------------------------

describe('Agent-to-task creation flow — task appears in list_tasks', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('standalone task created by agent appears in list_tasks with no filters', async () => {
		const handlers = makeHandlers(ctx);

		const createResult = await handlers.create_standalone_task({
			title: 'Fix login bug',
			description: 'Users cannot log in with special characters in password',
		});
		const createdTask = parseResult(createResult).task;

		const listResult = await handlers.list_tasks({});
		const listed = parseResult(listResult);
		expect(listed.success).toBe(true);
		expect(listed.total).toBe(1);
		expect(listed.tasks).toHaveLength(1);
		expect(listed.tasks[0].id).toBe(createdTask.id);
		expect(listed.tasks[0].title).toBe('Fix login bug');
	});

	test('multiple standalone tasks appear in list_tasks', async () => {
		const handlers = makeHandlers(ctx);

		await handlers.create_standalone_task({ title: 'Task A', description: 'desc a' });
		await handlers.create_standalone_task({ title: 'Task B', description: 'desc b' });
		await handlers.create_standalone_task({ title: 'Task C', description: 'desc c' });

		const listResult = await handlers.list_tasks({});
		const listed = parseResult(listResult);
		expect(listed.success).toBe(true);
		expect(listed.total).toBe(3);

		const titles = listed.tasks.map((t: { title: string }) => t.title);
		expect(titles).toContain('Task A');
		expect(titles).toContain('Task B');
		expect(titles).toContain('Task C');
	});

	test('standalone task is searchable by title in list_tasks', async () => {
		const handlers = makeHandlers(ctx);

		await handlers.create_standalone_task({ title: 'Fix payment gateway', description: 'desc' });
		await handlers.create_standalone_task({ title: 'Update documentation', description: 'desc' });

		const searchResult = await handlers.list_tasks({ search: 'payment' });
		const listed = parseResult(searchResult);
		expect(listed.total).toBe(1);
		expect(listed.tasks[0].title).toBe('Fix payment gateway');
	});

	test('standalone task is filterable by status in list_tasks', async () => {
		const handlers = makeHandlers(ctx);

		const r1 = await handlers.create_standalone_task({
			title: 'Open task',
			description: 'stays open',
		});
		const r2 = await handlers.create_standalone_task({
			title: 'Will start',
			description: 'will be in progress',
		});
		const task2Id = parseResult(r2).task.id;

		// Transition second task to in_progress
		await ctx.taskManager.startTask(task2Id);

		const openTasks = await handlers.list_tasks({ status: 'open' });
		const openParsed = parseResult(openTasks);
		expect(openParsed.total).toBe(1);
		expect(openParsed.tasks[0].title).toBe('Open task');

		const inProgressTasks = await handlers.list_tasks({ status: 'in_progress' });
		const ipParsed = parseResult(inProgressTasks);
		expect(ipParsed.total).toBe(1);
		expect(ipParsed.tasks[0].title).toBe('Will start');
	});

	test('standalone task appears in compact list_tasks results', async () => {
		const handlers = makeHandlers(ctx);

		const createResult = await handlers.create_standalone_task({
			title: 'Compact task',
			description: 'Should appear in compact mode',
			priority: 'high',
		});
		const createdTask = parseResult(createResult).task;

		const listResult = await handlers.list_tasks({ compact: true });
		const listed = parseResult(listResult);
		expect(listed.total).toBe(1);
		const compactTask = listed.tasks[0];
		expect(compactTask.id).toBe(createdTask.id);
		expect(compactTask.title).toBe('Compact task');
		expect(compactTask.status).toBe('open');
		expect(compactTask.priority).toBe('high');
		expect(compactTask.createdAt).toBeDefined();
		// Compact should NOT include description
		expect(compactTask.description).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Workflow pre-selection by agent — tasks with workflow association
// ---------------------------------------------------------------------------

describe('Agent-to-task creation flow — workflow association', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('start_workflow_run creates task with workflowRunId set', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Coding Workflow'
		);

		const result = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'Implement auth',
			description: 'JWT authentication',
		});
		const parsed = parseResult(result);
		expect(parsed.success).toBe(true);

		const task = parsed.tasks[0];
		expect(task.workflowRunId).toBe(parsed.run.id);
		expect(task.spaceId).toBe(ctx.spaceId);
		expect(task.status).toBe('open');
	});

	test('workflow-created task is filterable by workflow_run_id in list_tasks', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Dev Workflow'
		);
		const handlers = makeHandlers(ctx);

		// Create a workflow run (produces a task with workflowRunId)
		const runResult = await handlers.start_workflow_run({
			workflow_id: wf.id,
			title: 'Build feature X',
		});
		const runId = parseResult(runResult).run.id;

		// Also create a standalone task (no workflow association)
		await handlers.create_standalone_task({
			title: 'Standalone task',
			description: 'Not workflow-related',
		});

		// All tasks should include both
		const allResult = await handlers.list_tasks({});
		expect(parseResult(allResult).total).toBe(2);

		// Filter by workflow_run_id should return only the workflow task
		const filteredResult = await handlers.list_tasks({ workflow_run_id: runId });
		const filtered = parseResult(filteredResult);
		expect(filtered.total).toBe(1);
		expect(filtered.tasks[0].workflowRunId).toBe(runId);
		// Task title comes from the workflow node name, not the run title
		expect(filtered.tasks[0].title).toBeDefined();
	});

	test('agent workflow selection flow: suggest → select → start → verify task', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Full-Cycle Coding',
			['coding', 'v2'],
			'Full-cycle coding with plan, code, review'
		);
		const handlers = makeHandlers(ctx);

		// Step 1: Agent asks for workflow suggestions
		const suggestResult = await handlers.suggest_workflow({
			description: 'implement user authentication with coding and review',
		});
		const suggestions = parseResult(suggestResult);
		expect(suggestions.success).toBe(true);
		expect(suggestions.workflows.length).toBeGreaterThan(0);

		// Step 2: Agent picks the workflow and starts a run
		const selectedWorkflowId = suggestions.workflows[0].id;
		expect(selectedWorkflowId).toBe(wf.id);

		const runResult = await handlers.start_workflow_run({
			workflow_id: selectedWorkflowId,
			title: 'Implement auth system',
			description: 'Build JWT authentication',
		});
		const runParsed = parseResult(runResult);
		expect(runParsed.success).toBe(true);

		// Step 3: Verify the created task has workflow association
		const task = runParsed.tasks[0];
		expect(task.workflowRunId).toBe(runParsed.run.id);

		// Step 4: Verify task appears in list_tasks filtered by workflow_run_id
		const listResult = await handlers.list_tasks({
			workflow_run_id: runParsed.run.id,
		});
		const listed = parseResult(listResult);
		expect(listed.total).toBe(1);
		expect(listed.tasks[0].id).toBe(task.id);
	});

	test('workflow-created task persists workflowRunId to database', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Persist WF');

		const result = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'DB persistence check',
		});
		const parsed = parseResult(result);
		const taskId = parsed.tasks[0].id;
		const runId = parsed.run.id;

		// Verify in DB
		const stored = ctx.taskRepo.getTask(taskId);
		expect(stored).not.toBeNull();
		expect(stored!.workflowRunId).toBe(runId);
	});

	test('multiple workflow runs create tasks each linked to their own run', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Multi-run WF'
		);
		const handlers = makeHandlers(ctx);

		const run1 = await handlers.start_workflow_run({
			workflow_id: wf.id,
			title: 'Run 1',
		});
		const run2 = await handlers.start_workflow_run({
			workflow_id: wf.id,
			title: 'Run 2',
		});

		const run1Id = parseResult(run1).run.id;
		const run2Id = parseResult(run2).run.id;
		expect(run1Id).not.toBe(run2Id);

		// Each run's tasks should be independently filterable
		const list1 = parseResult(await handlers.list_tasks({ workflow_run_id: run1Id }));
		const list2 = parseResult(await handlers.list_tasks({ workflow_run_id: run2Id }));

		expect(list1.total).toBe(1);
		expect(list2.total).toBe(1);
		expect(list1.tasks[0].workflowRunId).toBe(run1Id);
		expect(list2.tasks[0].workflowRunId).toBe(run2Id);
	});
});

// ---------------------------------------------------------------------------
// Mixed flow: standalone + workflow tasks coexist
// ---------------------------------------------------------------------------

describe('Agent-to-task creation flow — mixed standalone and workflow tasks', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('standalone and workflow tasks both appear in unfiltered list_tasks', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Mix WF');
		const handlers = makeHandlers(ctx);

		// Agent creates a standalone task
		await handlers.create_standalone_task({
			title: 'Ad-hoc investigation',
			description: 'Look into performance issue',
		});

		// Agent starts a workflow run (creates workflow-associated task)
		await handlers.start_workflow_run({
			workflow_id: wf.id,
			title: 'Implement feature',
		});

		const listResult = await handlers.list_tasks({});
		const listed = parseResult(listResult);
		expect(listed.total).toBe(2);

		const titles = listed.tasks.map((t: { title: string }) => t.title);
		expect(titles).toContain('Ad-hoc investigation');

		// Verify one has workflow association and one doesn't
		const standalone = listed.tasks.find(
			(t: { title: string }) => t.title === 'Ad-hoc investigation'
		);
		const wfTask = listed.tasks.find((t: { title: string }) => t.title !== 'Ad-hoc investigation');

		expect(standalone.workflowRunId ?? null).toBeNull();
		expect(wfTask.workflowRunId).toBeDefined();
		expect(wfTask.workflowRunId).not.toBeNull();
	});

	test('status filter works across standalone and workflow tasks', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Status WF');
		const handlers = makeHandlers(ctx);

		// Create standalone task
		const standaloneResult = await handlers.create_standalone_task({
			title: 'Standalone open',
			description: 'stays open',
		});

		// Create workflow task
		const runResult = await handlers.start_workflow_run({
			workflow_id: wf.id,
			title: 'Workflow task',
		});
		const wfTaskId = parseResult(runResult).tasks[0].id;

		// Start the workflow task (transition to in_progress)
		await ctx.taskManager.startTask(wfTaskId);

		// Filter by open — should only return standalone
		const openList = parseResult(await handlers.list_tasks({ status: 'open' }));
		expect(openList.total).toBe(1);
		expect(openList.tasks[0].title).toBe('Standalone open');

		// Filter by in_progress — should only return workflow task
		const ipList = parseResult(await handlers.list_tasks({ status: 'in_progress' }));
		expect(ipList.total).toBe(1);
		expect(ipList.tasks[0].id).toBe(wfTaskId);
	});

	test('get_task_detail works for both standalone and workflow tasks', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Detail WF');
		const handlers = makeHandlers(ctx);

		const standaloneResult = await handlers.create_standalone_task({
			title: 'Standalone detail',
			description: 'standalone desc',
		});
		const standaloneId = parseResult(standaloneResult).task.id;

		const runResult = await handlers.start_workflow_run({
			workflow_id: wf.id,
			title: 'Workflow detail',
		});
		const wfTaskId = parseResult(runResult).tasks[0].id;

		// Get standalone by ID
		const s = parseResult(await handlers.get_task_detail({ task_id: standaloneId }));
		expect(s.success).toBe(true);
		expect(s.task.title).toBe('Standalone detail');
		expect(s.task.workflowRunId ?? null).toBeNull();

		// Get workflow task by ID
		const w = parseResult(await handlers.get_task_detail({ task_id: wfTaskId }));
		expect(w.success).toBe(true);
		expect(w.task.workflowRunId).toBeDefined();
		expect(w.task.workflowRunId).not.toBeNull();
	});
});
