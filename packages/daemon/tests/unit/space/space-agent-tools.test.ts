/**
 * Unit tests for createSpaceAgentToolHandlers()
 *
 * Covers (per M7 spec tools):
 * - list_workflows: returns space workflows
 * - start_workflow_run: explicit workflowId required; creates run + tasks
 * - get_workflow_run: returns run status, current step, and tasks
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
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
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
	agentId: string;
	workflowManager: SpaceWorkflowManager;
	workflowRunRepo: SpaceWorkflowRunRepository;
	taskRepo: SpaceTaskRepository;
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

	return { db, dir, spaceId, agentId, workflowManager, workflowRunRepo, taskRepo, runtime };
}

function makeHandlers(ctx: TestCtx) {
	return createSpaceAgentToolHandlers({
		spaceId: ctx.spaceId,
		runtime: ctx.runtime,
		workflowManager: ctx.workflowManager,
		taskRepo: ctx.taskRepo,
		workflowRunRepo: ctx.workflowRunRepo,
	});
}

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

	test('returns run with current step and tasks', async () => {
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
		expect(parsed.currentStep).toBeDefined();
		expect(parsed.tasks).toHaveLength(1);
	});

	test('returns error when run not found', async () => {
		const result = await makeHandlers(ctx).get_workflow_run({ run_id: 'run-missing' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('run-missing');
	});

	test('returns run with no currentStep when currentStepId is absent', async () => {
		// Create a run directly in the DB without a currentStepId
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'NoStep WF');
		const rawRun = ctx.workflowRunRepo.createRun({
			spaceId: ctx.spaceId,
			workflowId: wf.id,
			title: 'no-step run',
		});
		// Leave currentStepId null (pending run — no step assigned)

		const result = await makeHandlers(ctx).get_workflow_run({ run_id: rawRun.id });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.currentStep).toBeNull();
		expect(parsed.tasks).toHaveLength(0);
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
		ctx.workflowRunRepo.updateStatus(runId, 'completed');

		const result = await makeHandlers(ctx).change_plan({
			run_id: runId,
			description: 'new desc',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('completed');
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
		ctx.taskRepo.updateTask(taskId, { status: 'completed', completedAt: Date.now() });

		const result = await makeHandlers(ctx).list_tasks({ status: 'pending' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(1);
		expect(parsed.tasks[0].status).toBe('pending');
	});

	test('returns empty list when no tasks exist', async () => {
		const result = await makeHandlers(ctx).list_tasks({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.tasks).toHaveLength(0);
	});
});
