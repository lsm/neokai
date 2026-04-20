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
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import {
	createSpaceAgentMcpServer,
	createSpaceAgentToolHandlers,
} from '../../../../src/lib/space/tools/space-agent-tools.ts';
import type { SpaceTask, SpaceWorkflow } from '@neokai/shared';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

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

async function startWorkflowRun(
	ctx: TestCtx,
	args: { workflow_id?: string; workflowId?: string; title: string; description?: string }
) {
	const workflowId =
		args.workflow_id ??
		args.workflowId ??
		ctx.workflowManager.listWorkflows(ctx.spaceId)[0]?.id ??
		'';
	const { run, tasks } = await ctx.runtime.startWorkflowRun(
		ctx.spaceId,
		workflowId,
		args.title,
		args.description
	);
	return {
		content: [{ type: 'text', text: JSON.stringify({ success: true, run, tasks }) }],
	};
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

		const startResult = await startWorkflowRun(ctx, {
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
		const startResult = await startWorkflowRun(ctx, {
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

		const startResult = await startWorkflowRun(ctx, {
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
		const startResult = await startWorkflowRun(ctx, {
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
		const startResult = await startWorkflowRun(ctx, {
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
		const startResult = await startWorkflowRun(ctx, {
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
		await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 1' });
		await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 2' });

		const result = await makeHandlers(ctx).list_tasks({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(2);
	});

	test('filters tasks by workflow_run_id', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Filter WF');

		const r1 = await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run A' });
		const runId = JSON.parse(r1.content[0].text).run.id;

		await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run B' });

		const result = await makeHandlers(ctx).list_tasks({ workflow_run_id: runId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(1);
		expect(parsed.tasks[0].workflowRunId).toBe(runId);
	});

	test('filters tasks by status', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Status WF');

		const r1 = await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 1' });
		const taskId = JSON.parse(r1.content[0].text).tasks[0].id;

		await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 2' });

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

	test('returns every workflow unranked so the Space Agent LLM can pick', async () => {
		// suggest_workflow no longer keyword-ranks: it just surfaces the
		// catalogue so the caller's LLM can reason without bias.
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
		const names = parsed.workflows.map((w: { name: string }) => w.name).sort();
		expect(names).toEqual(['Coding Workflow', 'Research Workflow']);
	});

	test('does not keyword-rank — "review" tag no longer hijacks top spot', async () => {
		// Regression guard for the P0 bug that prompted switching to LLM-driven
		// selection: a task description containing "review feedback" used to
		// push the keyword-matching workflow (Review Flow) in front of the
		// workflow whose name/description actually fit the work (Coding Flow).
		const coding = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Coding Flow',
			['coding'],
			'Write code and open a PR'
		);
		const review = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'Review Flow',
			['review'],
			'Review a pull request'
		);

		const result = await makeHandlers(ctx).suggest_workflow({
			description: 'address review feedback and re-run the coding loop',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toHaveLength(2);
		// Order is creation order (insertion order) — never keyword rank.
		expect(parsed.workflows.map((w: { id: string }) => w.id)).toEqual([coding.id, review.id]);
	});

	test('returns all workflows for empty description', async () => {
		buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'My WF');

		const result = await makeHandlers(ctx).suggest_workflow({ description: '' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.workflows).toHaveLength(1);
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

	test('persists preferredWorkflowId when workflow_id is provided', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Coding QA');
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'Fix auth bug',
			description: 'Authentication fails for international users',
			workflow_id: wf.id,
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		const stored = ctx.taskRepo.getTask(parsed.task.id);
		expect(stored).not.toBeNull();
		expect(stored?.preferredWorkflowId).toBe(wf.id);
	});

	test('preferredWorkflowId is null when workflow_id not provided', async () => {
		const result = await makeHandlers(ctx).create_standalone_task({
			title: 'Generic task',
			description: 'No explicit workflow',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		const stored = ctx.taskRepo.getTask(parsed.task.id);
		expect(stored?.preferredWorkflowId ?? null).toBeNull();
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
		const startResult = await startWorkflowRun(ctx, {
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
		const startResult = await startWorkflowRun(ctx, {
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

		const result = await startWorkflowRun(ctx, {
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

		await startWorkflowRun(ctx, {
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

	test('suggest_workflow surfaces every workflow so the LLM can choose', async () => {
		// Post-refactor behavior: suggest_workflow no longer keyword-ranks.
		// The whole catalogue is returned in creation order so the caller's
		// LLM is not biased by substring overlap with the task description.
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
		expect(parsed.workflows).toHaveLength(2);
		const names = parsed.workflows.map((w: { name: string }) => w.name).sort();
		expect(names).toEqual(['Coding Workflow', 'Full-Cycle Coding Workflow']);
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
		await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 1' });
		await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 2' });

		const result = await makeHandlers(ctx).list_tasks({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.total).toBe(2);
		expect(parsed.tasks).toHaveLength(2);
	});

	test('filters tasks by search substring', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
		const r1 = await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 1' });
		const r2 = await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 2' });
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
			await startWorkflowRun(ctx, { workflow_id: wf.id, title: `run ${i + 1}` });
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
		await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 1' });

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
			const r = await startWorkflowRun(ctx, {
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

// ---------------------------------------------------------------------------
// approve_completion_action
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — approve_completion_action', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('rejects tasks that are not at a completion-action checkpoint', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'no pause',
			description: 'open task',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		// Flip status to review but leave pendingCheckpointType null — this is the
		// case where approve_task would apply, but approve_completion_action must
		// decline so callers don't accidentally bypass the runtime resume path.
		ctx.taskRepo.updateTask(taskId, { status: 'review' });

		const result = await makeHandlers(ctx).approve_completion_action({
			task_id: taskId,
			reason: 'whatever',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('not paused at a completion-action checkpoint');
	});

	test('rejects tasks not in review status', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'open task',
			description: 'not in review',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await makeHandlers(ctx).approve_completion_action({
			task_id: taskId,
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain("not 'review'");
	});

	test('rejects tasks that do not belong to this space', async () => {
		// Seed a task in a different space so we can query by that ID.
		const otherSpaceId = 'space-other';
		seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-workspace');
		const taskId = `task-other-${Math.random().toString(36).slice(2)}`;
		ctx.db
			.prepare(
				`INSERT INTO space_tasks (id, space_id, task_number, title, description,
					status, priority, depends_on, created_at, updated_at,
					pending_checkpoint_type, pending_action_index)
				 VALUES (?, ?, 1, 'Foreign task', '', 'review', 'normal', '[]', ?, ?, 'completion_action', 0)`
			)
			.run(taskId, otherSpaceId, Date.now(), Date.now());

		const result = await makeHandlers(ctx).approve_completion_action({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('does not belong to this space');
	});

	test('returns error when task not found', async () => {
		const result = await makeHandlers(ctx).approve_completion_action({
			task_id: 'task-missing',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('task-missing');
	});

	test('registers the tool in the MCP server', () => {
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
		const registered = (server.instance as unknown as { _registeredTools: Record<string, unknown> })
			._registeredTools;
		expect(registered).toHaveProperty('approve_completion_action');
		// approve_task remains for plain review→done approvals that are not
		// paused at a completion-action checkpoint.
		expect(registered).toHaveProperty('approve_task');
	});
});

// ---------------------------------------------------------------------------
// approve_task — completion-action checkpoint guard
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — approve_task guard', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('rejects tasks paused at a completion-action checkpoint', async () => {
		// Bypass guard: a plain `setTaskStatus('done')` on a completion-action
		// checkpoint would skip the pending action(s) entirely. approve_task
		// must decline and route callers to approve_completion_action.
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'paused at completion action',
			description: 'needs resume path',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		ctx.taskRepo.updateTask(taskId, {
			status: 'review',
			pendingCheckpointType: 'completion_action',
			pendingActionIndex: 0,
		});

		const result = await makeHandlers(ctx).approve_task({
			task_id: taskId,
			reason: 'lgtm',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('completion-action checkpoint');
		expect(parsed.error).toContain('approve_completion_action');
	});

	test('allows plain review→done approvals (no completion-action checkpoint)', async () => {
		const createResult = await makeHandlers(ctx).create_standalone_task({
			title: 'plain review task',
			description: 'no pending action',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		// Plain review (pendingCheckpointType is null) — approve_task should proceed.
		ctx.taskRepo.updateTask(taskId, { status: 'review' });

		const result = await makeHandlers(ctx).approve_task({
			task_id: taskId,
			reason: 'looks good',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('done');
	});
});

// ---------------------------------------------------------------------------
// send_message_to_task — node targeting, auto-spawn, task_number resolution
// ---------------------------------------------------------------------------

interface FakeTaskAgentManager {
	manager: TaskAgentManager;
	ensureCalls: string[];
	taskAgentInjects: Array<{ taskId: string; message: string }>;
	subSessionInjects: Array<{ sessionId: string; message: string }>;
	/** Session IDs that should throw `Sub-session not found` on inject. */
	deadSessionIds: Set<string>;
	/** Hook invoked before ensureTaskAgentSession resolves. Allows simulating
	 *  side-effects such as assigning a taskAgentSessionId. */
	onEnsure?: (taskId: string) => Promise<void> | void;
}

function makeFakeTaskAgentManager(ctx: TestCtx): FakeTaskAgentManager {
	const state: Omit<FakeTaskAgentManager, 'manager'> = {
		ensureCalls: [],
		taskAgentInjects: [],
		subSessionInjects: [],
		deadSessionIds: new Set(),
	};
	const manager = {
		async ensureTaskAgentSession(taskId: string): Promise<SpaceTask> {
			state.ensureCalls.push(taskId);
			if (state.onEnsure) await state.onEnsure(taskId);
			const task = ctx.taskRepo.getTask(taskId);
			if (!task) throw new Error(`Task not found: ${taskId}`);
			// Synthesise a sessionId the same way the real manager would.
			if (!task.taskAgentSessionId) {
				ctx.taskRepo.updateTask(taskId, {
					taskAgentSessionId: `space:${task.spaceId}:task:${taskId}`,
					status: task.status === 'open' ? 'in_progress' : task.status,
				});
			}
			return ctx.taskRepo.getTask(taskId) as SpaceTask;
		},
		async injectTaskAgentMessage(taskId: string, message: string): Promise<void> {
			state.taskAgentInjects.push({ taskId, message });
		},
		async injectSubSessionMessage(sessionId: string, message: string): Promise<void> {
			if (state.deadSessionIds.has(sessionId)) {
				throw new Error(`Sub-session not found: ${sessionId}`);
			}
			state.subSessionInjects.push({ sessionId, message });
		},
	} as unknown as TaskAgentManager;
	return { manager, ...state };
}

describe('createSpaceAgentToolHandlers — send_message_to_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	async function createTask(title = 'Test Task'): Promise<SpaceTask> {
		const created = await ctx.taskManager.createTask({
			title,
			description: 'desc',
			priority: 'normal',
		});
		return created;
	}

	function makeHandlersWith(
		tam: FakeTaskAgentManager,
		opts: { activateNode?: (runId: string, nodeId: string) => Promise<void> } = {}
	) {
		return createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
			spaceAgentManager: ctx.agentManager,
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			taskAgentManager: tam.manager,
			activateNode: opts.activateNode,
		});
	}

	test('returns an error when the task agent manager is unavailable', async () => {
		const handlers = createSpaceAgentToolHandlers({
			spaceId: ctx.spaceId,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			taskManager: ctx.taskManager,
			spaceAgentManager: ctx.agentManager,
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			// intentionally omitting taskAgentManager
		});
		const task = await createTask();
		const result = await handlers.send_message_to_task({
			task_id: task.id,
			message: 'hi',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Task agent communication');
	});

	test('returns an error when neither task_id nor task_number is provided', async () => {
		const tam = makeFakeTaskAgentManager(ctx);
		const result = await makeHandlersWith(tam).send_message_to_task({ message: 'hi' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toMatch(/task_id or task_number/);
	});

	test('auto-spawns the task agent and injects when no node_id is provided', async () => {
		const task = await createTask('Auto-spawn task');
		expect(task.taskAgentSessionId).toBeFalsy();

		const tam = makeFakeTaskAgentManager(ctx);
		const result = await makeHandlersWith(tam).send_message_to_task({
			task_id: task.id,
			message: 'kick off work',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.target).toBe('task-agent');
		expect(tam.ensureCalls).toEqual([task.id]);
		expect(tam.taskAgentInjects).toEqual([{ taskId: task.id, message: 'kick off work' }]);
		// task-agent session id is now recorded on the task
		const refreshed = ctx.taskRepo.getTask(task.id);
		expect(refreshed?.taskAgentSessionId).toBeTruthy();
	});

	test('auto-spawn reopens done/cancelled tasks (archived is the only tombstone)', async () => {
		const task = await createTask('Reopen task');
		ctx.taskRepo.updateTask(task.id, { status: 'done' });

		const tam = makeFakeTaskAgentManager(ctx);
		const result = await makeHandlersWith(tam).send_message_to_task({
			task_id: task.id,
			message: 'please revisit',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(tam.ensureCalls).toEqual([task.id]);
		expect(tam.taskAgentInjects).toEqual([{ taskId: task.id, message: 'please revisit' }]);
	});

	test('returns an error when the task is archived', async () => {
		const task = await createTask('Archived task');
		ctx.taskRepo.updateTask(task.id, { status: 'archived' });

		const tam = makeFakeTaskAgentManager(ctx);

		const resultNoNode = await makeHandlersWith(tam).send_message_to_task({
			task_id: task.id,
			message: 'hello',
		});
		const parsedNoNode = JSON.parse(resultNoNode.content[0].text);
		expect(parsedNoNode.success).toBe(false);
		expect(parsedNoNode.error).toMatch(/archived/);

		const resultWithNode = await makeHandlersWith(tam).send_message_to_task({
			task_id: task.id,
			node_id: 'coder',
			message: 'hello',
		});
		const parsedWithNode = JSON.parse(resultWithNode.content[0].text);
		expect(parsedWithNode.success).toBe(false);
		expect(parsedWithNode.error).toMatch(/archived/);

		// Neither path should have touched the task agent.
		expect(tam.ensureCalls).toHaveLength(0);
		expect(tam.taskAgentInjects).toHaveLength(0);
		expect(tam.subSessionInjects).toHaveLength(0);
	});

	test('resolves task_number to the correct task', async () => {
		const taskA = await createTask('task A');
		const taskB = await createTask('task B');
		expect(taskA.taskNumber).not.toBe(taskB.taskNumber);

		const tam = makeFakeTaskAgentManager(ctx);
		const result = await makeHandlersWith(tam).send_message_to_task({
			task_number: taskB.taskNumber,
			message: 'hi B',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task_id).toBe(taskB.id);
		expect(tam.taskAgentInjects).toEqual([{ taskId: taskB.id, message: 'hi B' }]);
	});

	test('returns an error when task_number does not match any task in this space', async () => {
		const tam = makeFakeTaskAgentManager(ctx);
		const result = await makeHandlersWith(tam).send_message_to_task({
			task_number: 99_999,
			message: 'hi',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('99999');
	});

	test('node_id by agent name routes directly to the live sub-session', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Coder');
		const { run, tasks } = await ctx.runtime.startWorkflowRun(
			ctx.spaceId,
			wf.id,
			'Node target run'
		);
		const task = tasks[0];
		// Seed two executions: a terminated Coder with a live session + a fresh Reviewer.
		const coderExec = ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId: run.id,
			workflowNodeId: wf.startNodeId,
			agentName: 'coder',
			agentSessionId: 'coder-session-live',
			status: 'idle',
		});

		const tam = makeFakeTaskAgentManager(ctx);
		const activateCalls: Array<[string, string]> = [];
		const handlers = makeHandlersWith(tam, {
			activateNode: async (r, n) => {
				activateCalls.push([r, n]);
			},
		});

		const result = await handlers.send_message_to_task({
			task_id: task.id,
			node_id: 'coder',
			message: 'refactor the parser',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.target).toBe('node');
		expect(parsed.node_execution_id).toBe(coderExec.id);
		expect(parsed.agent_name).toBe('coder');
		expect(parsed.activated).toBe(false);
		// Direct-injection path must skip activateNode.
		expect(activateCalls).toHaveLength(0);
		expect(tam.subSessionInjects).toEqual([
			{ sessionId: 'coder-session-live', message: 'refactor the parser' },
		]);
		// The Task Agent path was not touched.
		expect(tam.ensureCalls).toHaveLength(0);
		expect(tam.taskAgentInjects).toHaveLength(0);
	});

	test('node_id by execution UUID targets that specific execution', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF UUID');
		const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'UUID target');
		const task = tasks[0];
		// Two executions for the same agent name — UUID targeting must disambiguate.
		const reviewerA = ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId: run.id,
			workflowNodeId: wf.startNodeId,
			agentName: 'reviewer',
			agentSessionId: 'reviewer-a-session',
			status: 'idle',
		});
		const reviewerB = ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId: run.id,
			workflowNodeId: wf.startNodeId,
			agentName: 'reviewer-2',
			agentSessionId: 'reviewer-b-session',
			status: 'in_progress',
		});

		const tam = makeFakeTaskAgentManager(ctx);
		const handlers = makeHandlersWith(tam, { activateNode: async () => {} });

		const result = await handlers.send_message_to_task({
			task_id: task.id,
			node_id: reviewerB.id,
			message: 'please re-review',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.node_execution_id).toBe(reviewerB.id);
		expect(tam.subSessionInjects).toEqual([
			{ sessionId: 'reviewer-b-session', message: 'please re-review' },
		]);
		// Ensure the other reviewer was never touched.
		expect(tam.subSessionInjects.some((r) => r.sessionId === reviewerA.agentSessionId)).toBe(false);
	});

	test('auto-activates and injects when the targeted node has no live session', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Lazy');
		const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Lazy activate');
		const task = tasks[0];
		// Seed execution with NO agentSessionId — simulating a never-spawned node.
		const exec = ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId: run.id,
			workflowNodeId: wf.startNodeId,
			agentName: 'reviewer',
			status: 'pending',
		});

		const tam = makeFakeTaskAgentManager(ctx);
		const activateCalls: Array<[string, string]> = [];
		const handlers = makeHandlersWith(tam, {
			activateNode: async (runId, nodeId) => {
				activateCalls.push([runId, nodeId]);
				// Simulate ChannelRouter.activateNode() restoring a reusable session id.
				ctx.nodeExecutionRepo.update(exec.id, {
					status: 'in_progress',
					agentSessionId: 'reviewer-session-newly-restored',
				});
			},
		});

		const result = await handlers.send_message_to_task({
			task_id: task.id,
			node_id: 'reviewer',
			message: 'please re-review',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.activated).toBe(true);
		expect(parsed.node_execution_id).toBe(exec.id);
		expect(activateCalls).toEqual([[run.id, wf.startNodeId]]);
		expect(tam.subSessionInjects).toEqual([
			{
				sessionId: 'reviewer-session-newly-restored',
				message: 'please re-review',
			},
		]);
	});

	test('reports deferred delivery when activation creates no live session', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'WF Deferred'
		);
		const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Deferred');
		const task = tasks[0];
		const exec = ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId: run.id,
			workflowNodeId: wf.startNodeId,
			agentName: 'reviewer',
			status: 'pending',
		});

		const tam = makeFakeTaskAgentManager(ctx);
		const handlers = makeHandlersWith(tam, {
			activateNode: async () => {
				// Activation succeeded but did not attach a live session id — the tick
				// loop will spawn one later. The handler surfaces `delivered: false`.
			},
		});

		const result = await handlers.send_message_to_task({
			task_id: task.id,
			node_id: 'reviewer',
			message: 'queued reminder',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.activated).toBe(true);
		expect(parsed.delivered).toBe(false);
		expect(parsed.node_execution_id).toBe(exec.id);
		expect(tam.subSessionInjects).toHaveLength(0);
	});

	test('returns an error when node_id does not match any execution', async () => {
		const wf = buildSingleStepWorkflow(
			ctx.spaceId,
			ctx.workflowManager,
			ctx.agentId,
			'WF NotFound'
		);
		const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'run');
		const task = tasks[0];

		const tam = makeFakeTaskAgentManager(ctx);
		const handlers = makeHandlersWith(tam, { activateNode: async () => {} });
		const result = await handlers.send_message_to_task({
			task_id: task.id,
			node_id: 'nonexistent-agent',
			message: 'hi',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Node not found');
	});

	test('returns an error when node_id is provided but the task has no workflow run', async () => {
		const task = await createTask('No workflow task');
		expect(task.workflowRunId).toBeFalsy();

		const tam = makeFakeTaskAgentManager(ctx);
		const handlers = makeHandlersWith(tam, { activateNode: async () => {} });
		const result = await handlers.send_message_to_task({
			task_id: task.id,
			node_id: 'coder',
			message: 'hi',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('no workflow run');
	});

	test('agent-name resolution is case-insensitive', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Case');
		const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Case run');
		const task = tasks[0];

		const exec = ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId: run.id,
			workflowNodeId: wf.startNodeId,
			agentName: 'Reviewer',
			agentSessionId: 'reviewer-session-1',
			status: 'in_progress',
		});

		const tam = makeFakeTaskAgentManager(ctx);
		const handlers = makeHandlersWith(tam, { activateNode: async () => {} });
		const result = await handlers.send_message_to_task({
			task_id: task.id,
			node_id: 'REVIEWER',
			message: 'please look again',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.node_execution_id).toBe(exec.id);
		expect(tam.subSessionInjects).toEqual([
			{ sessionId: 'reviewer-session-1', message: 'please look again' },
		]);
	});

	test('task_id takes precedence when both task_id and task_number are supplied', async () => {
		const taskA = await createTask('task A');
		const taskB = await createTask('task B');

		const tam = makeFakeTaskAgentManager(ctx);
		const result = await makeHandlersWith(tam).send_message_to_task({
			task_id: taskA.id,
			task_number: taskB.taskNumber,
			message: 'hello',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task_id).toBe(taskA.id);
		expect(tam.taskAgentInjects).toEqual([{ taskId: taskA.id, message: 'hello' }]);
	});

	test('falls back to activateNode when a previously-live session rejects injection', async () => {
		// Execution has an agentSessionId but the sub-session is dead (e.g. daemon
		// restart cleaned it up). First injection throws; handler must fall through
		// to activateNode, which revives the execution with a fresh session id.
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Dead');
		const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Dead session');
		const task = tasks[0];
		const exec = ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId: run.id,
			workflowNodeId: wf.startNodeId,
			agentName: 'coder',
			agentSessionId: 'coder-dead',
			status: 'idle',
		});

		const tam = makeFakeTaskAgentManager(ctx);
		tam.deadSessionIds.add('coder-dead');
		const activateCalls: Array<[string, string]> = [];
		const handlers = makeHandlersWith(tam, {
			activateNode: async (runId, nodeId) => {
				activateCalls.push([runId, nodeId]);
				ctx.nodeExecutionRepo.update(exec.id, {
					status: 'in_progress',
					agentSessionId: 'coder-new',
				});
			},
		});

		const result = await handlers.send_message_to_task({
			task_id: task.id,
			node_id: 'coder',
			message: 'retry',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.activated).toBe(true);
		expect(activateCalls).toEqual([[run.id, wf.startNodeId]]);
		expect(tam.subSessionInjects).toEqual([{ sessionId: 'coder-new', message: 'retry' }]);
	});

	test('returns an error when the target task belongs to a different space', async () => {
		const otherSpaceId = 'space-other-owner';
		seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-workspace');
		const foreignTaskId = `task-foreign-${Math.random().toString(36).slice(2)}`;
		ctx.db
			.prepare(
				`INSERT INTO space_tasks (id, space_id, task_number, title, description,
					status, priority, depends_on, created_at, updated_at)
				 VALUES (?, ?, 1, 'Foreign task', '', 'open', 'normal', '[]', ?, ?)`
			)
			.run(foreignTaskId, otherSpaceId, Date.now(), Date.now());

		const tam = makeFakeTaskAgentManager(ctx);
		const result = await makeHandlersWith(tam).send_message_to_task({
			task_id: foreignTaskId,
			message: 'hi',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('does not belong to this space');
	});
});
