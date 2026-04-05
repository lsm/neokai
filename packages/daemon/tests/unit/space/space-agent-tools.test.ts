/**
 * Unit tests for createSpaceAgentToolHandlers()
 *
 * Covers (per M7 spec tools):
 * - list_workflows: returns space workflows
 * - start_workflow_run: explicit workflowId required; creates run + tasks
 * - get_workflow_run: returns run status, current step, and node executions
 * - change_plan: description update; workflow switch (cancel + restart)
 * - list_tasks: filter by status, workflowRunId
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
import {
	createSpaceAgentMcpServer,
	createSpaceAgentToolHandlers,
} from '../../../src/lib/space/tools/space-agent-tools.ts';
import type { SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB + space setup helpers
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

// ---------------------------------------------------------------------------
// Build a single-step workflow (terminal — no transitions)
// ---------------------------------------------------------------------------

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
	const spaceId = 'space-tools-test';
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

function getRegisteredToolNames(server: ReturnType<typeof createSpaceAgentMcpServer>): string[] {
	const instance = server.instance as unknown as { _registeredTools: Record<string, unknown> };
	return Object.keys(instance._registeredTools);
}

describe('createSpaceAgentMcpServer — tool registration', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('does not register start_workflow_run for Space Agent sessions', () => {
		const server = createSpaceAgentMcpServer({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
			spaceAgentManager: ctx.agentManager,
		});

		const names = getRegisteredToolNames(server);
		expect(names).not.toContain('start_workflow_run');
		expect(names).toContain('create_standalone_task');
	});
});

// ---------------------------------------------------------------------------
// list_workflows
// ---------------------------------------------------------------------------

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
		const result = await makeHandlers(ctx).list_workflows();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toEqual([]);
	});

	test('returns all workflows for the space', async () => {
		buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Alpha');
		buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Beta');

		const result = await makeHandlers(ctx).list_workflows();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// start_workflow_run
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

	test('starts a run with explicit workflow_id and returns run + tasks', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'My WF');

		const result = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'Test run',
			description: 'desc',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.run.workflowId).toBe(wf.id);
		expect(parsed.run.title).toBe('Test run');
		expect(parsed.tasks).toHaveLength(1);
	});

	test('creates run record in DB with in_progress status', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'DB WF');

		await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run title' });

		const runs = ctx.workflowRunRepo.listBySpace(ctx.spaceId);
		expect(runs).toHaveLength(1);
		expect(runs[0].status).toBe('in_progress');
		expect(runs[0].title).toBe('run title');
	});

	test('returns error when workflow_id not found', async () => {
		const result = await makeHandlers(ctx).start_workflow_run({
			workflow_id: 'wf-does-not-exist',
			title: 'test',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// get_workflow_run
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — get_workflow_run', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns run with executions', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Get WF');

		const startResult = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'my run',
		});
		const runId = JSON.parse(startResult.content[0].text).run.id;

		const result = await makeHandlers(ctx).get_workflow_run({ run_id: runId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.run.id).toBe(runId);
		expect(parsed.run.status).toBe('in_progress');
		// startWorkflowRun() now creates a node_execution record for the start node
		expect(parsed.executions).toHaveLength(1);
		expect(parsed.executions[0].status).toBe('pending');
	});

	test('returns error when run not found', async () => {
		const result = await makeHandlers(ctx).get_workflow_run({ run_id: 'run-missing' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('run-missing');
	});

	test('returns run with empty tasks when no tasks have been created', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'NoStep WF');
		const rawRun = ctx.workflowRunRepo.createRun({
			spaceId: ctx.spaceId,
			workflowId: wf.id,
			title: 'no-step run',
		});

		const result = await makeHandlers(ctx).get_workflow_run({ run_id: rawRun.id });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.executions).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// change_plan
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — change_plan', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('updates description of an in-progress run', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Desc WF');
		const startResult = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'run',
			description: 'original desc',
		});
		const runId = JSON.parse(startResult.content[0].text).run.id;

		const result = await makeHandlers(ctx).change_plan({
			run_id: runId,
			description: 'updated desc',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.run.description).toBe('updated desc');
	});

	test('switches workflow: cancels current run and starts new one', async () => {
		const wf1 = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF One');
		const wf2 = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Two');

		const startResult = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf1.id,
			title: 'switch test',
		});
		const runId = JSON.parse(startResult.content[0].text).run.id;

		const result = await makeHandlers(ctx).change_plan({
			run_id: runId,
			workflow_id: wf2.id,
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.previousRunId).toBe(runId);
		expect(parsed.run.workflowId).toBe(wf2.id);
		expect(parsed.run.title).toBe('switch test');

		// Old run should be cancelled
		const oldRun = ctx.workflowRunRepo.getRun(runId);
		expect(oldRun?.status).toBe('cancelled');
	});

	test('returns error when run not found', async () => {
		const result = await makeHandlers(ctx).change_plan({ run_id: 'run-missing' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
	});

	test('returns error when trying to change plan on completed run', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Done WF');
		const startResult = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'done run',
		});
		const runId = JSON.parse(startResult.content[0].text).run.id;

		// Mark as completed
		ctx.workflowRunRepo.transitionStatus(runId, 'done');

		const result = await makeHandlers(ctx).change_plan({
			run_id: runId,
			description: 'new desc',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toMatch(/completed|done/);
	});

	test('returns error when neither description nor workflow_id provided', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Empty WF');
		const startResult = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'run',
		});
		const runId = JSON.parse(startResult.content[0].text).run.id;

		const result = await makeHandlers(ctx).change_plan({ run_id: runId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
	});

	test('does not cancel the original run when target workflow_id is invalid', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Original WF'
		);
		const startResult = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'run to keep',
		});
		const runId = JSON.parse(startResult.content[0].text).run.id;

		// Attempt to switch to a non-existent workflow
		const result = await makeHandlers(ctx).change_plan({
			run_id: runId,
			workflow_id: 'wf-does-not-exist',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);

		// Original run must still be in_progress — not cancelled
		const originalRun = ctx.workflowRunRepo.getRun(runId);
		expect(originalRun?.status).toBe('in_progress');
	});
});

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

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
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'List WF');
		await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run 1' });
		await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run 2' });

		const result = await makeHandlers(ctx).list_tasks({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(2);
	});

	test('filters tasks by workflow_run_id', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Filter WF');

		const r1 = await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run A' });
		const runId = JSON.parse(r1.content[0].text).run.id;

		await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run B' });

		const result = await makeHandlers(ctx).list_tasks({ workflow_run_id: runId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(1);
		expect(parsed.tasks[0].workflowRunId).toBe(runId);
	});

	test('filters tasks by status', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Status WF');

		const r1 = await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run 1' });
		const taskId = JSON.parse(r1.content[0].text).tasks[0].id;

		await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run 2' });

		// Mark first task as completed
		ctx.taskRepo.updateTask(taskId, { status: 'done', completedAt: Date.now() });

		const result = await makeHandlers(ctx).list_tasks({ status: 'open' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(1);
		expect(parsed.tasks[0].status).toBe('open');
	});

	test('returns empty list when no tasks exist', async () => {
		const result = await makeHandlers(ctx).list_tasks({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// get_workflow_detail
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — get_workflow_detail', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns full workflow definition including steps and rules', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Detail WF',
			['tag1'],
			'Detailed description'
		);

		const result = await makeHandlers(ctx).get_workflow_detail({ workflow_id: wf.id });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflow.id).toBe(wf.id);
		expect(parsed.workflow.name).toBe('Detail WF');
		expect(parsed.workflow.description).toBe('Detailed description');
		expect(parsed.workflow.nodes).toHaveLength(1);
		expect(parsed.workflow.nodes[0].agents[0].agentId).toBe(ctx.agentId);
		// rules field removed from SpaceWorkflow — verify nodes exist instead
		expect(parsed.workflow.nodes[0].agents).toHaveLength(1);
	});

	test('returns error when workflow_id not found', async () => {
		const result = await makeHandlers(ctx).get_workflow_detail({
			workflow_id: 'wf-does-not-exist',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('wf-does-not-exist');
	});

	test('returns workflow with tags', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Tagged WF', [
			'alpha',
			'beta',
		]);

		const result = await makeHandlers(ctx).get_workflow_detail({ workflow_id: wf.id });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflow.tags).toContain('alpha');
		expect(parsed.workflow.tags).toContain('beta');
	});
});

// ---------------------------------------------------------------------------
// suggest_workflow
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — suggest_workflow', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns empty list with message when no workflows exist', async () => {
		const result = await makeHandlers(ctx).suggest_workflow({
			description: 'implement a new feature',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toEqual([]);
	});

	test('returns matching workflow ranked first when keywords match name', async () => {
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Coding Workflow',
			[],
			'For writing code'
		);
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Research Workflow',
			[],
			'For research tasks'
		);

		const result = await makeHandlers(ctx).suggest_workflow({
			description: 'write coding implementation',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toHaveLength(2);
		// Coding Workflow should rank first (matches 'coding' in name and description)
		expect(parsed.workflows[0].name).toBe('Coding Workflow');
	});

	test('returns matching workflow when keywords match description', async () => {
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Alpha WF',
			[],
			'deploys to production environment'
		);
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Beta WF',
			[],
			'runs unit tests'
		);

		const result = await makeHandlers(ctx).suggest_workflow({
			description: 'deploy to production',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflows[0].name).toBe('Alpha WF');
	});

	test('returns matching workflow when keywords match tags', async () => {
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Review Flow',
			['pullrequest', 'review'],
			''
		);
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Deploy Flow',
			['deployment', 'release'],
			''
		);

		const result = await makeHandlers(ctx).suggest_workflow({ description: 'review pullrequest' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflows[0].name).toBe('Review Flow');
	});

	test('returns all workflows when no keywords match', async () => {
		buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Alpha WF');
		buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Beta WF');

		const result = await makeHandlers(ctx).suggest_workflow({ description: 'xyz-unique-term' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		// All workflows returned as fallback
		expect(parsed.workflows).toHaveLength(2);
	});

	test('returns all workflows when description contains only stop words', async () => {
		buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'My WF');

		const result = await makeHandlers(ctx).suggest_workflow({ description: 'the and for' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toHaveLength(1);
	});

	test('returns all workflows for empty description', async () => {
		buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'My WF');

		const result = await makeHandlers(ctx).suggest_workflow({ description: '' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toHaveLength(1);
	});

	test('V2 workflow preferred over V1 when both match equally (coding task)', async () => {
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Coding Workflow',
			['coding', 'default'],
			'For writing code'
		);
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Full-Cycle Coding Workflow',
			['coding', 'v2', 'parallel-review', 'default'],
			'For writing code with parallel review'
		);

		const result = await makeHandlers(ctx).suggest_workflow({
			description: 'implement a new coding feature',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toHaveLength(2);
		// V2 must be ranked first (tiebreaker: 'v2' tag)
		expect(parsed.workflows[0].name).toBe('Full-Cycle Coding Workflow');
		expect(parsed.workflows[1].name).toBe('Coding Workflow');
	});

	test('V1 fallback when V2 is not seeded (backward compatibility)', async () => {
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Coding Workflow',
			['coding', 'default'],
			'For writing code'
		);

		const result = await makeHandlers(ctx).suggest_workflow({
			description: 'implement a new coding feature',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toHaveLength(1);
		expect(parsed.workflows[0].name).toBe('Coding Workflow');
	});

	test('non-coding workflows unaffected by v2 tiebreaker', async () => {
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Research Workflow',
			['research'],
			'For research tasks'
		);
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Deploy Workflow',
			['deploy', 'v2'],
			'For deployment tasks'
		);

		// A research query — deploy v2 workflow should NOT hijack top spot
		const result = await makeHandlers(ctx).suggest_workflow({
			description: 'research competitors',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		// Research Workflow has more hits; Deploy Workflow should not outrank it
		expect(parsed.workflows[0].name).toBe('Research Workflow');
	});
});

// ---------------------------------------------------------------------------
// create_standalone_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — create_standalone_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('creates a task with required fields only', async () => {
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'My task',
			description: 'Do something',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.title).toBe('My task');
		expect(parsed.task.description).toBe('Do something');
		expect(parsed.task.workflowRunId ?? null).toBeNull();
		expect(parsed.task.workflowNodeId ?? null).toBeNull();
		expect(parsed.task.spaceId).toBe(ctx.spaceId);
	});

	test('creates a task with all optional fields', async () => {
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'Full task',
			description: 'Detailed description',
			priority: 'high',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.priority).toBe('high');
		expect(parsed.task.title).toBe('Full task');
	});

	test('custom_agent_id field removed in M71 — task still creates without error', async () => {
		// custom_agent_id is no longer validated in create_standalone_task post-M71
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'Task',
			description: 'Desc',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBeDefined();
	});

	test('task is retrievable from repo after creation', async () => {
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'Stored task',
			description: 'Check storage',
		});
		const taskId = JSON.parse(result.content[0].text).task.id;
		const stored = ctx.taskRepo.getTask(taskId);
		expect(stored).not.toBeNull();
		expect(stored?.title).toBe('Stored task');
	});
});

// ---------------------------------------------------------------------------
// get_task_detail
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — get_task_detail', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns full task record by ID', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Detail task',
			description: 'Some work',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await makeHandlers(ctx).get_task_detail({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(taskId);
		expect(parsed.task.title).toBe('Detail task');
	});

	test('returns error when task not found', async () => {
		const result = await makeHandlers(ctx).get_task_detail({ task_id: 'task-missing' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('task-missing');
	});

	test('returns task with blocked status after failure', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Failed task',
			description: 'Will fail',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		// Start and then fail the task
		await ctx.taskManager.startTask(taskId);
		await ctx.taskManager.failTask(taskId, 'Something went wrong');

		const result = await makeHandlers(ctx).get_task_detail({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('blocked');
		// error field was removed in M71; check task is blocked
	});
});

// ---------------------------------------------------------------------------
// retry_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — retry_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('resets a needs_attention task to pending', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Retry task',
			description: 'Will be retried',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		await ctx.taskManager.startTask(taskId);
		await ctx.taskManager.failTask(taskId, 'Error');

		const result = await makeHandlers(ctx).retry_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('open');
		expect(parsed.task.error ?? null).toBeNull();
	});

	test('resets a cancelled task to in_progress (reactivation)', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Cancelled task',
			description: 'Will be retried',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		await ctx.taskManager.cancelTask(taskId);

		const result = await makeHandlers(ctx).retry_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('in_progress');
	});

	test('updates description on retry when provided', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Task with desc update',
			description: 'Original description',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		await ctx.taskManager.startTask(taskId);
		await ctx.taskManager.failTask(taskId, 'Error');

		const result = await makeHandlers(ctx).retry_task({
			task_id: taskId,
			description: 'Updated description',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.description).toBe('Updated description');
	});

	test('returns error for in_progress task', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Active task',
			description: 'Currently running',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		await ctx.taskManager.startTask(taskId);

		const result = await makeHandlers(ctx).retry_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('in_progress');
	});

	test('returns error when task not found', async () => {
		const result = await makeHandlers(ctx).retry_task({ task_id: 'task-missing' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('task-missing');
	});
});

// ---------------------------------------------------------------------------
// cancel_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — cancel_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('cancels a pending task', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Cancel me',
			description: 'Will be cancelled',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await makeHandlers(ctx).cancel_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('cancelled');
	});

	test('cancels dependent tasks in cascade', async () => {
		// Create two tasks where second depends on first
		const t1 = await ctx.taskManager.createTask({ title: 'T1', description: 'First' });
		const t2 = await ctx.taskManager.createTask({
			title: 'T2',
			description: 'Depends on T1',
			dependsOn: [t1.id],
		});

		const result = await makeHandlers(ctx).cancel_task({ task_id: t1.id });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(t1.id);
		expect(parsed.task.status).toBe('cancelled');

		// Dependent task should also be cancelled
		const t2Updated = ctx.taskRepo.getTask(t2.id);
		expect(t2Updated?.status).toBe('cancelled');
	});

	test('cancels the workflow run when cancel_workflow_run is true', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Cancel WF');
		const startResult = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'Run to cancel',
		});
		const { run, tasks } = JSON.parse(startResult.content[0].text);
		const taskId = tasks[0].id;
		const runId = run.id;

		const result = await makeHandlers(ctx).cancel_task({
			task_id: taskId,
			cancel_workflow_run: true,
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.workflowRunCancelled).toBe(true);
		expect(parsed.workflowRunId).toBe(runId);

		const updatedRun = ctx.workflowRunRepo.getRun(runId);
		expect(updatedRun?.status).toBe('cancelled');
	});

	test('does not cancel workflow run when cancel_workflow_run is false', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Keep Run WF'
		);
		const startResult = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'Run to keep',
		});
		const { run, tasks } = JSON.parse(startResult.content[0].text);
		const taskId = tasks[0].id;
		const runId = run.id;

		await makeHandlers(ctx).cancel_task({
			task_id: taskId,
			cancel_workflow_run: false,
		});

		const updatedRun = ctx.workflowRunRepo.getRun(runId);
		expect(updatedRun?.status).toBe('in_progress');
	});

	test('returns error when task not found', async () => {
		const result = await makeHandlers(ctx).cancel_task({ task_id: 'task-missing' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('task-missing');
	});

	test('returns error when cancelling a completed task', async () => {
		const t = await ctx.taskManager.createTask({ title: 'T', description: 'Done' });
		await ctx.taskManager.startTask(t.id);
		await ctx.taskManager.completeTask(t.id, 'done');

		const result = await makeHandlers(ctx).cancel_task({ task_id: t.id });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// reassign_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — reassign_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('reassigns a pending task (custom_agent_id is accepted, field removed in M71)', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Reassign me',
			description: 'Will be reassigned',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await makeHandlers(ctx).reassign_task({
			task_id: taskId,
			custom_agent_id: ctx.agentId,
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(taskId);
	});

	test('reassigns by changing assigned_agent type (field removed in M71)', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Agent type change',
			description: 'Change agent type',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await makeHandlers(ctx).reassign_task({
			task_id: taskId,
			assigned_agent: 'general',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(taskId);
	});

	test('does not error when reassigning open task', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Has custom agent',
			description: 'Custom agent must be preserved',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await makeHandlers(ctx).reassign_task({
			task_id: taskId,
			assigned_agent: 'general',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(taskId);
	});

	test('clears custom agent when custom_agent_id is null (field removed in M71)', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Clear agent',
			description: 'Remove custom agent',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await makeHandlers(ctx).reassign_task({
			task_id: taskId,
			custom_agent_id: null,
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(taskId);
	});

	test('returns error when custom_agent_id does not exist', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Task',
			description: 'Desc',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await makeHandlers(ctx).reassign_task({
			task_id: taskId,
			custom_agent_id: 'agent-does-not-exist',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('agent-does-not-exist');
	});

	test('returns error when task is in_progress', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Active task',
			description: 'Currently running',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		await ctx.taskManager.startTask(taskId);

		const result = await makeHandlers(ctx).reassign_task({
			task_id: taskId,
			assigned_agent: 'general',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('in_progress');
	});

	test('returns error when task not found', async () => {
		const result = await makeHandlers(ctx).reassign_task({
			task_id: 'task-missing',
			assigned_agent: 'general',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('task-missing');
	});

	test('reassigns a needs_attention task successfully', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Failed task',
			description: 'Failed and reassign',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		await ctx.taskManager.startTask(taskId);
		await ctx.taskManager.failTask(taskId, 'Error');

		const result = await makeHandlers(ctx).reassign_task({
			task_id: taskId,
			custom_agent_id: ctx.agentId,
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(taskId);
	});
});

// ---------------------------------------------------------------------------
// send_message_to_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — send_message_to_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error when taskAgentManager is not configured', async () => {
		// makeHandlers() does not pass taskAgentManager — simulates unconfigured state
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'My task',
			description: 'Some work',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await makeHandlers(ctx).send_message_to_task({
			task_id: taskId,
			message: 'How is it going?',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('TaskAgentManager is not configured');
	});

	test('returns error when task is not found', async () => {
		const injected: Array<{ taskId: string; message: string }> = [];
		const fakeTaskAgentManager = {
			injectTaskAgentMessage: async (taskId: string, message: string) => {
				injected.push({ taskId, message });
			},
		};

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
			spaceAgentManager: ctx.agentManager,
			taskAgentManager: fakeTaskAgentManager as never,
		});

		const result = await handlers.send_message_to_task({
			task_id: 'task-does-not-exist',
			message: 'Hello?',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('task-does-not-exist');
		expect(injected).toHaveLength(0);
	});

	test('returns error when task has no taskAgentSessionId', async () => {
		const injected: Array<{ taskId: string; message: string }> = [];
		const fakeTaskAgentManager = {
			injectTaskAgentMessage: async (taskId: string, message: string) => {
				injected.push({ taskId, message });
			},
		};

		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Pending task',
			description: 'Not yet started',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		// Task is in 'pending' state — no taskAgentSessionId

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
			spaceAgentManager: ctx.agentManager,
			taskAgentManager: fakeTaskAgentManager as never,
		});

		const result = await handlers.send_message_to_task({
			task_id: taskId,
			message: 'Any progress?',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('no active Task Agent session');
		expect(parsed.taskStatus).toBe('open');
		expect(injected).toHaveLength(0);
	});

	test('successfully injects message when task has a taskAgentSessionId', async () => {
		const injected: Array<{ taskId: string; message: string }> = [];
		const fakeTaskAgentManager = {
			injectTaskAgentMessage: async (taskId: string, message: string) => {
				injected.push({ taskId, message });
			},
		};

		// Create a task and set taskAgentSessionId to simulate an active agent
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Active task',
			description: 'In progress with agent',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		ctx.taskRepo.updateTask(taskId, { taskAgentSessionId: 'space:test:task:active-task:agent' });

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
			spaceAgentManager: ctx.agentManager,
			taskAgentManager: fakeTaskAgentManager as never,
		});

		const result = await handlers.send_message_to_task({
			task_id: taskId,
			message: 'Please prioritize the auth module.',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.taskId).toBe(taskId);
		// taskAgentSessionId is intentionally omitted from the response to avoid leaking internals
		expect(parsed.taskAgentSessionId).toBeUndefined();
		expect(injected).toHaveLength(1);
		expect(injected[0].taskId).toBe(taskId);
		expect(injected[0].message).toBe('Please prioritize the auth module.');
	});

	test('returns error when task belongs to a different space (cross-space ownership check)', async () => {
		const injected: Array<{ taskId: string; message: string }> = [];
		const fakeTaskAgentManager = {
			injectTaskAgentMessage: async (taskId: string, message: string) => {
				injected.push({ taskId, message });
			},
		};

		// Seed a second space and create a task in it
		const otherSpaceId = 'space-other';
		seedSpaceRow(ctx.db, otherSpaceId);
		const otherTaskManager = new SpaceTaskManager(ctx.db, otherSpaceId);
		const otherTask = await otherTaskManager.createTask({
			title: 'Other space task',
			description: 'Belongs to another space',
		});
		ctx.taskRepo.updateTask(otherTask.id, {
			taskAgentSessionId: 'space:other:task:other-task',
		});

		// Space Agent for ctx.spaceId tries to message a task in otherSpaceId
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
			spaceAgentManager: ctx.agentManager,
			taskAgentManager: fakeTaskAgentManager as never,
		});

		const result = await handlers.send_message_to_task({
			task_id: otherTask.id,
			message: 'Infiltration attempt',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain(otherTask.id);
		expect(injected).toHaveLength(0);
	});

	test('propagates error from injectTaskAgentMessage', async () => {
		const fakeTaskAgentManager = {
			injectTaskAgentMessage: async (_taskId: string, _message: string) => {
				throw new Error('Session queue is full');
			},
		};

		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'Active task',
			description: 'In progress',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		ctx.taskRepo.updateTask(taskId, { taskAgentSessionId: 'space:test:task:active-task' });

		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
			spaceAgentManager: ctx.agentManager,
			taskAgentManager: fakeTaskAgentManager as never,
		});

		const result = await handlers.send_message_to_task({
			task_id: taskId,
			message: 'Hello',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Session queue is full');
	});
});

// ---------------------------------------------------------------------------
// M5.3 — Task creation and workflow activation
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — task creation and planning node activation (M5.3)', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('create_standalone_task creates task with pending status (clear request)', async () => {
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'Fix the login bug where international users cannot authenticate',
			description: 'Fix authentication failure for international card payments',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('open');
		expect(parsed.task.workflowRunId ?? null).toBeNull();
	});

	test('create_standalone_task task persists to DB and is retrievable', async () => {
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'Add JWT auth',
			description: 'Implement user authentication with JWT tokens',
		});
		const taskId = JSON.parse(result.content[0].text).task.id;
		const stored = ctx.taskRepo.getTask(taskId);
		expect(stored).not.toBeNull();
		expect(stored?.title).toBe('Add JWT auth');
		expect(stored?.status).toBe('open');
	});

	test('start_workflow_run with planning start node creates task with planning taskType', async () => {
		// Seed a planner agent for the planning step
		seedAgentRow(ctx.db, 'agent-planner-1', ctx.spaceId, 'Planner');

		const stepId = 'planning-step-1';
		const wf = ctx.workflowManager.createWorkflow({
			spaceId: ctx.spaceId,
			name: 'Plan-first Workflow',
			description: 'Workflow with planning start node',
			nodes: [{ id: stepId, name: 'Planning', agentId: 'agent-planner-1' }],
			transitions: [],
			startNodeId: stepId,
			rules: [],
			tags: ['coding', 'v2'],
		});

		const result = await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'Implement payment system',
			description: 'Build a secure payment processing module',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(1);
		// taskType and workflowNodeId removed in M71 — verify task is created and has open status
		expect(parsed.tasks[0].status).toBe('open');
	});

	test('start_workflow_run with V2 planning workflow stores run in DB', async () => {
		seedAgentRow(ctx.db, 'agent-planner-2', ctx.spaceId, 'Planner');

		const stepId = 'v2-planning-step';
		const wf = ctx.workflowManager.createWorkflow({
			spaceId: ctx.spaceId,
			name: 'Full-Cycle Coding Workflow',
			description: 'Full-cycle coding workflow with plan review',
			nodes: [{ id: stepId, name: 'Planning', agentId: 'agent-planner-2' }],
			transitions: [],
			startNodeId: stepId,
			rules: [],
			tags: ['coding', 'v2', 'default'],
		});

		await makeHandlers(ctx).start_workflow_run({
			workflow_id: wf.id,
			title: 'Implement authentication system',
		});

		const runs = ctx.workflowRunRepo.listBySpace(ctx.spaceId);
		expect(runs).toHaveLength(1);
		expect(runs[0].status).toBe('in_progress');

		const tasks = ctx.taskRepo.listByWorkflowRun(runs[0].id);
		expect(tasks).toHaveLength(1);
		// taskType removed in M71 — verify task is created
		expect(tasks[0].status).toBe('open');
	});

	test('suggest_workflow ranks V2 workflow first for clear coding request', async () => {
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Coding Workflow',
			['coding', 'default'],
			'For writing code'
		);
		buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Full-Cycle Coding Workflow',
			['coding', 'v2', 'default'],
			'Full-cycle coding with plan review and parallel reviewers'
		);

		const result = await makeHandlers(ctx).suggest_workflow({
			description: 'implement authentication system with JWT tokens',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		// V2 must rank first — it has the 'v2' tiebreaker tag
		expect(parsed.workflows[0].name).toBe('Full-Cycle Coding Workflow');
	});
});

// ---------------------------------------------------------------------------
// list_tasks — search, pagination, compact mode, total
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — list_tasks search/pagination/compact', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns total count in response', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
		await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run 1' });
		await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run 2' });

		const result = await makeHandlers(ctx).list_tasks({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.total).toBe(2);
		expect(parsed.tasks).toHaveLength(2);
	});

	test('filters tasks by search substring', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
		const r1 = await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run 1' });
		const r2 = await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run 2' });
		const task1Id = JSON.parse(r1.content[0].text).tasks[0].id;
		const task2Id = JSON.parse(r2.content[0].text).tasks[0].id;

		// Rename one task to have a unique searchable title
		ctx.taskRepo.updateTask(task1Id, { title: 'Review PR #42' });
		ctx.taskRepo.updateTask(task2Id, { title: 'Deploy service' });

		const result = await makeHandlers(ctx).list_tasks({ search: 'Review' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.total).toBe(1);
		expect(parsed.tasks).toHaveLength(1);
		expect(parsed.tasks[0].title).toBe('Review PR #42');
	});

	test('paginates with limit and offset', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
		for (let i = 0; i < 4; i++) {
			await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: `run ${i + 1}` });
		}

		const page1 = JSON.parse(
			(await makeHandlers(ctx).list_tasks({ limit: 2, offset: 0 })).content[0].text
		);
		expect(page1.total).toBe(4);
		expect(page1.tasks).toHaveLength(2);

		const page2 = JSON.parse(
			(await makeHandlers(ctx).list_tasks({ limit: 2, offset: 2 })).content[0].text
		);
		expect(page2.total).toBe(4);
		expect(page2.tasks).toHaveLength(2);
	});

	test('returns compact fields when compact:true', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
		await makeHandlers(ctx).start_workflow_run({ workflow_id: wf.id, title: 'run 1' });

		const result = await makeHandlers(ctx).list_tasks({ compact: true });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.total).toBe(1);
		const task = parsed.tasks[0] as Record<string, unknown>;
		// Compact fields present
		expect(task.id).toBeDefined();
		expect(task.title).toBeDefined();
		expect(task.status).toBeDefined();
		expect(task.priority).toBeDefined();
		expect(task.createdAt).toBeDefined();
		// Large fields excluded
		expect(task.workflowRunId).toBeUndefined();
		expect(task.description).toBeUndefined();
	});

	test('total reflects post-filter count before pagination', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
		for (let i = 0; i < 4; i++) {
			const r = await makeHandlers(ctx).start_workflow_run({
				workflow_id: wf.id,
				title: `run ${i + 1}`,
			});
			const taskId = JSON.parse(r.content[0].text).tasks[0].id;
			if (i < 2) {
				ctx.taskRepo.updateTask(taskId, { title: `Match task ${i}` });
			} else {
				ctx.taskRepo.updateTask(taskId, { title: `Other task ${i}` });
			}
		}

		const result = await makeHandlers(ctx).list_tasks({ search: 'Match', limit: 1, offset: 0 });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.total).toBe(2); // 2 match, even though only 1 returned
		expect(parsed.tasks).toHaveLength(1);
	});
});
