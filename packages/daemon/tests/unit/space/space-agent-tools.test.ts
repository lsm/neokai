/**
 * Unit tests for createSpaceAgentToolHandlers()
 *
 * Covers:
 * - start_workflow_run: explicit workflowId, auto-select via tags, no match → error
 * - create_task: creates standalone task (no workflowRunId)
 * - list_workflows: returns space workflows
 * - list_tasks: filter by status, workflowRunId
 * - list_workflow_runs: filter by status
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
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import { createSpaceAgentToolHandlers } from '../../../src/lib/space/tools/space-agent-tools.ts';
import type { SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB + space setup helpers (same pattern as space-runtime.test.ts)
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-space-agent-tools',
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
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, Date.now(), Date.now());
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

// ---------------------------------------------------------------------------
// Build a minimal linear workflow (single step — no transitions, immediately terminal)
// ---------------------------------------------------------------------------

function buildSingleStepWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	agentId: string,
	name: string,
	tags: string[],
	description = ''
): SpaceWorkflow {
	const stepId = `step-${Math.random().toString(36).slice(2)}`;
	return workflowManager.createWorkflow({
		spaceId,
		name,
		description,
		steps: [{ id: stepId, name: 'Work', agentId }],
		transitions: [],
		startStepId: stepId,
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
	workspacePath: string;
	agentId: string;
	workflowManager: SpaceWorkflowManager;
	workflowRunRepo: SpaceWorkflowRunRepository;
	taskRepo: SpaceTaskRepository;
	taskManager: SpaceTaskManager;
	runtime: SpaceRuntime;
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-tools-test';
	const workspacePath = '/tmp/test-workspace';

	seedSpaceRow(db, spaceId, workspacePath);

	const agentId = 'agent-coder-1';
	seedAgentRow(db, agentId, spaceId, 'Coder', 'coder');

	const agentRepo = new SpaceAgentRepository(db);
	const agentManager = new SpaceAgentManager(agentRepo);

	const workflowRepo = new SpaceWorkflowRepository(db);
	// No agentLookup passed — same pattern as space-runtime.test.ts
	const workflowManager = new SpaceWorkflowManager(workflowRepo);

	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const taskRepo = new SpaceTaskRepository(db);
	const spaceManager = new SpaceManager(db);

	const runtime = new SpaceRuntime({
		db,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		workflowRunRepo,
		taskRepo,
	});

	const taskManager = new SpaceTaskManager(db, spaceId);

	return {
		db,
		dir,
		spaceId,
		workspacePath,
		agentId,
		workflowManager,
		workflowRunRepo,
		taskRepo,
		taskManager,
		runtime,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — start_workflow_run', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('explicit workflowId starts a run and returns tasks', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'My Workflow',
			['coding']
		);

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const result = await handlers.start_workflow_run({
			title: 'Test run',
			description: 'desc',
			workflow_id: wf.id,
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.run).toBeDefined();
		expect(parsed.run.workflowId).toBe(wf.id);
		expect(parsed.tasks).toHaveLength(1);
		expect(parsed.selectedWorkflowId).toBe(wf.id);
	});

	test('auto-selects workflow via tag match when no workflowId provided', async () => {
		const wfCoding = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Coding Workflow',
			['coding']
		);
		buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Research Workflow', [
			'research',
		]);

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const result = await handlers.start_workflow_run({
			title: 'implement coding feature',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.selectedWorkflowId).toBe(wfCoding.id);
	});

	test('returns error when no workflow matches and no workflowId provided', async () => {
		// No workflows in space
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const result = await handlers.start_workflow_run({
			title: 'some task',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toBeDefined();
	});

	test('returns error when explicit workflowId not found', async () => {
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const result = await handlers.start_workflow_run({
			title: 'test',
			workflow_id: 'wf-does-not-exist',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
	});

	test('creates run record in DB with in_progress status', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'DB Run Workflow',
			['coding']
		);

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		await handlers.start_workflow_run({ title: 'run title', workflow_id: wf.id });

		const runs = ctx.workflowRunRepo.listBySpace(ctx.spaceId);
		expect(runs).toHaveLength(1);
		expect(runs[0].status).toBe('in_progress');
		expect(runs[0].title).toBe('run title');
	});
});

describe('createSpaceAgentToolHandlers — create_task', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('creates a standalone task with no workflowRunId', async () => {
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const result = await handlers.create_task({
			title: 'Standalone task',
			description: 'Do something useful',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.taskId).toBeDefined();
		expect(parsed.task.title).toBe('Standalone task');
		expect(parsed.task.workflowRunId).toBeUndefined();
	});

	test('creates task with specified task_type', async () => {
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const result = await handlers.create_task({
			title: 'Research task',
			description: 'Research something',
			task_type: 'research',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.taskType).toBe('research');
	});

	test('creates task with custom_agent_id', async () => {
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const result = await handlers.create_task({
			title: 'Custom agent task',
			description: 'Use custom agent',
			custom_agent_id: ctx.agentId,
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.customAgentId).toBe(ctx.agentId);
	});

	test('creates task with pending status by default', async () => {
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const result = await handlers.create_task({
			title: 'Default status task',
			description: 'Should be pending',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('pending');
	});
});

describe('createSpaceAgentToolHandlers — list_workflows', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns empty list when no workflows exist', async () => {
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const result = await handlers.list_workflows();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toEqual([]);
	});

	test('returns all workflows for the space', async () => {
		buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Alpha', ['alpha']);
		buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Beta', ['beta']);

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const result = await handlers.list_workflows();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toHaveLength(2);
	});
});

describe('createSpaceAgentToolHandlers — list_tasks', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns all tasks when no filter applied', async () => {
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		await handlers.create_task({ title: 'Task 1', description: 'desc' });
		await handlers.create_task({ title: 'Task 2', description: 'desc' });

		const result = await handlers.list_tasks({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(2);
	});

	test('filters tasks by status', async () => {
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		// Create two tasks — both will be 'pending'
		const r1 = await handlers.create_task({ title: 'T1', description: 'd' });
		const p1 = JSON.parse(r1.content[0].text);
		// Complete the first task via repo update directly
		ctx.taskRepo.updateTask(p1.taskId, {
			status: 'completed',
			completedAt: Date.now(),
		});

		await handlers.create_task({ title: 'T2', description: 'd' });

		const result = await handlers.list_tasks({ status: 'pending' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(1);
		expect(parsed.tasks[0].title).toBe('T2');
	});

	test('filters tasks by workflow_run_id', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Filter WF', [
			'coding',
		]);

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		// Create a workflow run (produces 1 task)
		const runResult = await handlers.start_workflow_run({
			title: 'run for filter test',
			workflow_id: wf.id,
		});
		const runParsed = JSON.parse(runResult.content[0].text);
		const runId = runParsed.run.id;

		// Create a standalone task
		await handlers.create_task({ title: 'standalone', description: 'no run' });

		// Filter by run ID
		const result = await handlers.list_tasks({ workflow_run_id: runId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(1);
		expect(parsed.tasks[0].workflowRunId).toBe(runId);
	});
});

describe('createSpaceAgentToolHandlers — list_workflow_runs', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns all runs when no filter applied', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Run List WF',
			['coding']
		);

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		await handlers.start_workflow_run({ title: 'run 1', workflow_id: wf.id });
		await handlers.start_workflow_run({ title: 'run 2', workflow_id: wf.id });

		const result = await handlers.list_workflow_runs({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.runs).toHaveLength(2);
	});

	test('filters runs by status', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Status Filter WF',
			['coding']
		);

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
		});

		const r1 = await handlers.start_workflow_run({ title: 'run A', workflow_id: wf.id });
		const runId = JSON.parse(r1.content[0].text).run.id;

		await handlers.start_workflow_run({ title: 'run B', workflow_id: wf.id });

		// Mark run A as cancelled
		ctx.workflowRunRepo.updateStatus(runId, 'cancelled');

		const result = await handlers.list_workflow_runs({ status: 'in_progress' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.runs).toHaveLength(1);
		expect(parsed.runs[0].title).toBe('run B');
	});
});
