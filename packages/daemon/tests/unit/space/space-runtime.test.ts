/**
 * SpaceRuntime Integration Tests
 *
 * Covers:
 * - startWorkflowRun(): creates run, executor, first task with correct taskType
 * - executeTick(): advances completed tasks to next step
 * - Gate enforcement: human gate blocks advancement, needs_attention set
 * - Standalone tasks: tasks without workflowRunId are not processed by executor map
 * - Rule injection: getRulesForStep() filters correctly
 * - Rehydration: executors reconstructed from DB on startup
 * - Executor cleanup: removed from map on run complete/cancel
 * - resolveTaskTypeForStep(): correct mapping for planner, coder, general, custom roles
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
import type { SpaceRuntimeConfig } from '../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceWorkflow, SpaceWorkflowRun } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-space-runtime',
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
// Fixture helpers
// ---------------------------------------------------------------------------

function buildLinearWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	steps: Array<{ id: string; name: string; agentId: string; instructions?: string }>,
	conditions: Array<{ type: 'always' | 'human'; description?: string }> = []
): SpaceWorkflow {
	// Build transitions: step[i] → step[i+1] with conditions[i]
	const transitions = steps.slice(0, -1).map((step, i) => ({
		from: step.id,
		to: steps[i + 1].id,
		condition: conditions[i] ?? { type: 'always' as const },
		order: 0,
	}));

	return workflowManager.createWorkflow({
		spaceId,
		name: `Test Workflow ${Date.now()}-${Math.random()}`,
		description: 'Test',
		steps,
		transitions,
		startStepId: steps[0].id,
		rules: [],
		tags: [],
	});
}

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

describe('SpaceRuntime', () => {
	let db: BunDatabase;
	let dir: string;

	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let runtime: SpaceRuntime;

	const SPACE_ID = 'space-rt-1';
	const WORKSPACE = '/tmp/runtime-ws';

	// Agent IDs for preset roles
	const AGENT_PLANNER = 'agent-planner';
	const AGENT_CODER = 'agent-coder';
	const AGENT_GENERAL = 'agent-general';
	const AGENT_CUSTOM = 'agent-custom';

	// Step ID constants
	const STEP_A = 'step-a';
	const STEP_B = 'step-b';
	const STEP_C = 'step-c';

	beforeEach(() => {
		({ db, dir } = makeDb());

		// Seed space
		seedSpaceRow(db, SPACE_ID, WORKSPACE);

		// Seed agents with different roles
		seedAgentRow(db, AGENT_PLANNER, SPACE_ID, 'Planner', 'planner');
		seedAgentRow(db, AGENT_CODER, SPACE_ID, 'Coder', 'coder');
		seedAgentRow(db, AGENT_GENERAL, SPACE_ID, 'General', 'general');
		seedAgentRow(db, AGENT_CUSTOM, SPACE_ID, 'Custom', 'my-custom-role');

		// Build managers and repos
		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);

		spaceManager = new SpaceManager(db);

		const config: SpaceRuntimeConfig = {
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
		};
		runtime = new SpaceRuntime(config);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	// -------------------------------------------------------------------------
	// resolveTaskTypeForStep
	// -------------------------------------------------------------------------

	describe('resolveTaskTypeForStep()', () => {
		test('planner role → planning taskType, no customAgentId', () => {
			const step = { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER };
			const result = runtime.resolveTaskTypeForStep(step);
			expect(result.taskType).toBe('planning');
			expect(result.customAgentId).toBeUndefined();
		});

		test('coder role → coding taskType, no customAgentId', () => {
			const step = { id: STEP_A, name: 'Code', agentId: AGENT_CODER };
			const result = runtime.resolveTaskTypeForStep(step);
			expect(result.taskType).toBe('coding');
			expect(result.customAgentId).toBeUndefined();
		});

		test('general role → coding taskType, no customAgentId', () => {
			const step = { id: STEP_A, name: 'Research', agentId: AGENT_GENERAL };
			const result = runtime.resolveTaskTypeForStep(step);
			expect(result.taskType).toBe('coding');
			expect(result.customAgentId).toBeUndefined();
		});

		test('custom role → coding taskType + customAgentId = step.agentId', () => {
			const step = { id: STEP_A, name: 'Custom', agentId: AGENT_CUSTOM };
			const result = runtime.resolveTaskTypeForStep(step);
			expect(result.taskType).toBe('coding');
			expect(result.customAgentId).toBe(AGENT_CUSTOM);
		});

		test('unknown agentId → coding taskType + customAgentId = step.agentId', () => {
			const step = { id: STEP_A, name: 'Unknown', agentId: 'non-existent-uuid' };
			const result = runtime.resolveTaskTypeForStep(step);
			expect(result.taskType).toBe('coding');
			expect(result.customAgentId).toBe('non-existent-uuid');
		});
	});

	// -------------------------------------------------------------------------
	// getRulesForStep
	// -------------------------------------------------------------------------

	describe('getRulesForStep()', () => {
		test('returns empty array when workflow not found', () => {
			const rules = runtime.getRulesForStep('nonexistent-workflow-id', STEP_A);
			expect(rules).toEqual([]);
		});

		test('returns all rules when appliesTo is empty (applies to all steps)', () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'Rules Test Workflow',
				steps: [{ id: STEP_A, name: 'Step A', agentId: AGENT_CODER }],
				transitions: [],
				startStepId: STEP_A,
				rules: [
					{ name: 'Global Rule', content: 'Always be concise', appliesTo: [] },
					{ name: 'Another Global', content: 'Write tests', appliesTo: undefined as never },
				],
				tags: [],
			});

			const rules = runtime.getRulesForStep(workflow.id, STEP_A);
			expect(rules).toHaveLength(2);
		});

		test('filters rules by step ID when appliesTo is set', () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'Filtered Rules Workflow',
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_PLANNER },
				],
				transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
				startStepId: STEP_A,
				rules: [
					{ name: 'Step A Rule', content: 'Rule for step A only', appliesTo: [STEP_A] },
					{ name: 'Step B Rule', content: 'Rule for step B only', appliesTo: [STEP_B] },
					{ name: 'Global Rule', content: 'Rule for all steps', appliesTo: [] },
				],
				tags: [],
			});

			// Rules for step A: step A rule + global
			const rulesForA = runtime.getRulesForStep(workflow.id, STEP_A);
			expect(rulesForA).toHaveLength(2);
			expect(rulesForA.map((r) => r.name)).toEqual(
				expect.arrayContaining(['Step A Rule', 'Global Rule'])
			);

			// Rules for step B: step B rule + global
			const rulesForB = runtime.getRulesForStep(workflow.id, STEP_B);
			expect(rulesForB).toHaveLength(2);
			expect(rulesForB.map((r) => r.name)).toEqual(
				expect.arrayContaining(['Step B Rule', 'Global Rule'])
			);
		});
	});

	// -------------------------------------------------------------------------
	// startWorkflowRun()
	// -------------------------------------------------------------------------

	describe('startWorkflowRun()', () => {
		test('creates run record with in_progress status', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Test Run');

			expect(run.spaceId).toBe(SPACE_ID);
			expect(run.workflowId).toBe(workflow.id);
			expect(run.status).toBe('in_progress');
			expect(run.currentStepId).toBe(STEP_A);
		});

		test('creates initial SpaceTask for the start step', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'My Run');

			expect(tasks).toHaveLength(1);
			const task = tasks[0];
			expect(task.workflowRunId).toBe(tasks[0].workflowRunId);
			expect(task.workflowStepId).toBe(STEP_A);
			expect(task.status).toBe('pending');
			expect(task.title).toBe('Plan');
		});

		test('assigns correct taskType for planner start step', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(tasks[0].taskType).toBe('planning');
		});

		test('assigns correct taskType for coder start step', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Code', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(tasks[0].taskType).toBe('coding');
		});

		test('registers executor in executors map', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(runtime.executorCount).toBe(1);
			expect(runtime.getExecutor(run.id)).toBeDefined();
		});

		test('throws for unknown workflow', async () => {
			await expect(runtime.startWorkflowRun(SPACE_ID, 'nonexistent-wf-id', 'Run')).rejects.toThrow(
				'Workflow not found'
			);
		});

		test('throws for unknown space', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			await expect(
				runtime.startWorkflowRun('nonexistent-space', workflow.id, 'Run')
			).rejects.toThrow('Space not found');
		});

		test('stores description on run record', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run } = await runtime.startWorkflowRun(
				SPACE_ID,
				workflow.id,
				'My Run',
				'Some description'
			);

			expect(run.description).toBe('Some description');
		});
	});

	// -------------------------------------------------------------------------
	// executeTick() — advancement
	// -------------------------------------------------------------------------

	describe('executeTick() — workflow advancement', () => {
		test('advances run when start step task is completed (always condition)', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Complete the first step task
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			// Tick — should advance to step B
			await runtime.executeTick();

			// A new task for step B should exist
			const allTasks = taskRepo.listByWorkflowRun(run.id);
			expect(allTasks).toHaveLength(2);

			const stepBTask = allTasks.find((t) => t.workflowStepId === STEP_B);
			expect(stepBTask).toBeDefined();
			expect(stepBTask!.status).toBe('pending');
			expect(stepBTask!.taskType).toBe('coding');
		});

		test('does not advance when step task is still in_progress', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });

			await runtime.executeTick();

			const allTasks = taskRepo.listByWorkflowRun(run.id);
			expect(allTasks).toHaveLength(1); // no new task created
		});

		test('marks run as completed when terminal step is advanced past', async () => {
			// Single step workflow — advancing past it completes the run
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await runtime.executeTick();

			const updatedRun = workflowRunRepo.getRun(run.id);
			expect(updatedRun!.status).toBe('completed');

			// Executor should be cleaned up
			expect(runtime.getExecutor(run.id)).toBeUndefined();
		});

		test('three-step workflow advances through all steps', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
					{ id: STEP_C, name: 'Review', agentId: AGENT_GENERAL },
				],
				[{ type: 'always' }, { type: 'always' }]
			);

			const { run, tasks: initialTasks } = await runtime.startWorkflowRun(
				SPACE_ID,
				workflow.id,
				'Run'
			);

			// Complete step A task → tick → step B task created
			taskRepo.updateTask(initialTasks[0].id, { status: 'completed' });
			await runtime.executeTick();

			const stepBTask = taskRepo.listByWorkflowRun(run.id).find((t) => t.workflowStepId === STEP_B);
			expect(stepBTask).toBeDefined();

			// Complete step B task → tick → step C task created
			taskRepo.updateTask(stepBTask!.id, { status: 'completed' });
			await runtime.executeTick();

			const stepCTask = taskRepo.listByWorkflowRun(run.id).find((t) => t.workflowStepId === STEP_C);
			expect(stepCTask).toBeDefined();

			// Complete step C task → tick → run completes (terminal step)
			taskRepo.updateTask(stepCTask!.id, { status: 'completed' });
			await runtime.executeTick();

			const finalRun = workflowRunRepo.getRun(run.id);
			expect(finalRun!.status).toBe('completed');
			expect(runtime.getExecutor(run.id)).toBeUndefined();
		});

		test('assigns correct taskType to tasks created by advance()', async () => {
			// Plan → Code (planner → coder)
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await runtime.executeTick();

			const stepBTask = taskRepo
				.listByWorkflowRun(run.id)
				.find((t) => t.workflowStepId === STEP_B)!;

			expect(stepBTask.taskType).toBe('coding');
		});

		test('sets customAgentId for custom-role agent in advance() result', async () => {
			// Coder → Custom
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Code', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Custom Step', agentId: AGENT_CUSTOM },
				],
				[{ type: 'always' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await runtime.executeTick();

			const stepBTask = taskRepo
				.listByWorkflowRun(run.id)
				.find((t) => t.workflowStepId === STEP_B)!;

			expect(stepBTask.taskType).toBe('coding');
			expect(stepBTask.customAgentId).toBe(AGENT_CUSTOM);
		});
	});

	// -------------------------------------------------------------------------
	// Gate enforcement — human condition
	// -------------------------------------------------------------------------

	describe('gate enforcement', () => {
		test('human gate blocks advancement and sets run to needs_attention', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'human' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			// Tick — human gate should block advancement
			await runtime.executeTick();

			const updatedRun = workflowRunRepo.getRun(run.id);
			expect(updatedRun!.status).toBe('needs_attention');

			// No new task should be created for step B
			const allTasks = taskRepo.listByWorkflowRun(run.id);
			expect(allTasks).toHaveLength(1);
		});

		test('executor is retained after gate block (can be retried)', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'human' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await runtime.executeTick();

			// Executor should still be in the map
			expect(runtime.getExecutor(run.id)).toBeDefined();
		});

		test('advances after human approval is set in run.config', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'human' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			// First tick — gate blocks
			await runtime.executeTick();
			expect(workflowRunRepo.getRun(run.id)!.status).toBe('needs_attention');

			// External approval: reset status and set humanApproved flag
			workflowRunRepo.updateRun(run.id, {
				status: 'in_progress',
				config: { humanApproved: true },
			});

			// Second tick — gate passes
			await runtime.executeTick();

			const stepBTask = taskRepo.listByWorkflowRun(run.id).find((t) => t.workflowStepId === STEP_B);
			expect(stepBTask).toBeDefined();
		});
	});

	// -------------------------------------------------------------------------
	// Standalone tasks
	// -------------------------------------------------------------------------

	describe('standalone tasks', () => {
		test('standalone task (no workflowRunId) is not processed by executor map', async () => {
			// Create a standalone task directly via repo
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone Task',
				description: 'No workflow',
				status: 'pending',
			});

			// Tick should not throw and executor count stays 0
			await runtime.executeTick();

			expect(runtime.executorCount).toBe(0);

			// Task status unchanged
			const unchanged = taskRepo.getTask(task.id)!;
			expect(unchanged.status).toBe('pending');
		});

		test('multiple workflow runs can coexist without interference', async () => {
			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT_CODER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_B, name: 'Step B', agentId: AGENT_PLANNER },
			]);

			const { run: run1, tasks: tasks1 } = await runtime.startWorkflowRun(
				SPACE_ID,
				wf1.id,
				'Run 1'
			);
			const { run: run2, tasks: tasks2 } = await runtime.startWorkflowRun(
				SPACE_ID,
				wf2.id,
				'Run 2'
			);

			expect(runtime.executorCount).toBe(2);

			// Complete run1's task only
			taskRepo.updateTask(tasks1[0].id, { status: 'completed' });

			await runtime.executeTick();

			// run1 should complete (terminal step), run2 still active
			expect(workflowRunRepo.getRun(run1.id)!.status).toBe('completed');
			expect(workflowRunRepo.getRun(run2.id)!.status).toBe('in_progress');
			expect(runtime.executorCount).toBe(1);
			expect(runtime.getExecutor(run1.id)).toBeUndefined();
			expect(runtime.getExecutor(run2.id)).toBeDefined();

			// Complete run2's task
			taskRepo.updateTask(tasks2[0].id, { status: 'completed' });
			await runtime.executeTick();

			expect(workflowRunRepo.getRun(run2.id)!.status).toBe('completed');
			expect(runtime.executorCount).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Rehydration
	// -------------------------------------------------------------------------

	describe('rehydrateExecutors()', () => {
		test('rehydrates in-progress runs on first executeTick() call', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			// Create a run and initial task using repo directly (simulating prior server run)
			const pendingRun = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Rehydration Run',
				currentStepId: STEP_A,
			});
			const run = workflowRunRepo.updateStatus(pendingRun.id, 'in_progress')!;

			// Create and complete the start step task
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Plan',
				description: '',
				workflowRunId: run.id,
				workflowStepId: STEP_A,
				status: 'completed',
			});
			expect(task.status).toBe('completed');

			// Build a fresh runtime (no executors loaded yet)
			const freshRuntime = new SpaceRuntime({
				db,
				spaceManager,
				spaceAgentManager: agentManager,
				spaceWorkflowManager: workflowManager,
				workflowRunRepo,
				taskRepo,
			});

			expect(freshRuntime.executorCount).toBe(0);

			// executeTick() should rehydrate the executor and advance the run
			await freshRuntime.executeTick();

			// Executor for the run should now exist
			// The completed step A task should trigger advancement to step B
			const allTasks = taskRepo.listByWorkflowRun(run.id);
			const stepBTask = allTasks.find((t) => t.workflowStepId === STEP_B);
			expect(stepBTask).toBeDefined();
		});

		test('rehydration is idempotent (second executeTick does not double-rehydrate)', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// First tick — triggers rehydration check (rehydrated already set)
			await runtime.executeTick();

			// Second tick — should not duplicate executors
			await runtime.executeTick();

			expect(runtime.executorCount).toBeLessThanOrEqual(1);
		});

		test('skips runs whose workflow was deleted', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const pendingRun = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Orphaned Run',
				currentStepId: STEP_A,
			});
			workflowRunRepo.updateStatus(pendingRun.id, 'in_progress');

			// Delete the workflow
			workflowManager.deleteWorkflow(workflow.id);

			// Fresh runtime — should not throw, should skip the orphaned run
			const freshRuntime = new SpaceRuntime({
				db,
				spaceManager,
				spaceAgentManager: agentManager,
				spaceWorkflowManager: workflowManager,
				workflowRunRepo,
				taskRepo,
			});

			await expect(freshRuntime.executeTick()).resolves.toBeUndefined();
			expect(freshRuntime.executorCount).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Executor cleanup
	// -------------------------------------------------------------------------

	describe('executor cleanup', () => {
		test('executor removed from map when run completes', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(runtime.executorCount).toBe(1);

			taskRepo.updateTask(tasks[0].id, { status: 'completed' });
			await runtime.executeTick();

			expect(runtime.getExecutor(run.id)).toBeUndefined();
			expect(runtime.executorCount).toBe(0);
		});

		test('cleanupTerminalExecutors() removes cancelled runs', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(runtime.executorCount).toBe(1);

			// Externally cancel the run
			workflowRunRepo.updateStatus(run.id, 'cancelled');

			// executeTick → processCompletedTasks skips cancelled, cleanupTerminalExecutors removes it
			await runtime.executeTick();

			expect(runtime.getExecutor(run.id)).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// seedPresetAgents + seedBuiltInWorkflows wiring (space-handlers)
	// -------------------------------------------------------------------------

	describe('space.create seeding (unit-level check)', () => {
		test('seedBuiltInWorkflows can be called after seedPresetAgents successfully', async () => {
			// Create a new space DB row
			const newSpaceId = 'space-seed-test';
			const newWorkspacePath = '/tmp/seed-test';
			seedSpaceRow(db, newSpaceId, newWorkspacePath);

			const { seedPresetAgents } = await import('../../../src/lib/space/agents/seed-agents.ts');
			const { seedBuiltInWorkflows } = await import(
				'../../../src/lib/space/workflows/built-in-workflows.ts'
			);

			// Seed agents
			const result = await seedPresetAgents(newSpaceId, agentManager);
			expect(result.errors).toHaveLength(0);
			expect(result.seeded.length).toBeGreaterThan(0);

			// Seed workflows using role resolver
			const agents = agentManager.listBySpaceId(newSpaceId);
			expect(() =>
				seedBuiltInWorkflows(
					newSpaceId,
					workflowManager,
					(role) => agents.find((a) => a.role === role)?.id
				)
			).not.toThrow();

			// Three built-in workflows should exist
			const workflows = workflowManager.listWorkflows(newSpaceId);
			expect(workflows).toHaveLength(3);
		});

		test('seedBuiltInWorkflows is idempotent (calling twice is a no-op)', async () => {
			const newSpaceId = 'space-seed-idempotent';
			const newWorkspacePath = '/tmp/seed-idempotent';
			seedSpaceRow(db, newSpaceId, newWorkspacePath);

			const { seedPresetAgents } = await import('../../../src/lib/space/agents/seed-agents.ts');
			const { seedBuiltInWorkflows } = await import(
				'../../../src/lib/space/workflows/built-in-workflows.ts'
			);

			await seedPresetAgents(newSpaceId, agentManager);
			const agents = agentManager.listBySpaceId(newSpaceId);
			const resolver = (role: string) => agents.find((a) => a.role === role)?.id;

			seedBuiltInWorkflows(newSpaceId, workflowManager, resolver);
			seedBuiltInWorkflows(newSpaceId, workflowManager, resolver); // second call is no-op

			const workflows = workflowManager.listWorkflows(newSpaceId);
			expect(workflows).toHaveLength(3); // still 3, not 6
		});
	});
});
