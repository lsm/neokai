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
	// resolveTaskTypesForStep (multi-agent variant)
	// -------------------------------------------------------------------------

	describe('resolveTaskTypesForStep()', () => {
		test('single agentId shorthand → one-element array with correct resolution', () => {
			const step = { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER };
			const results = runtime.resolveTaskTypesForStep(step);
			expect(results).toHaveLength(1);
			expect(results[0].taskType).toBe('planning');
			expect(results[0].customAgentId).toBeUndefined();
		});

		test('multi-agent step → one ResolvedTaskType per agent entry', () => {
			const step = {
				id: STEP_A,
				name: 'Multi',
				agents: [{ agentId: AGENT_PLANNER }, { agentId: AGENT_CODER }, { agentId: AGENT_CUSTOM }],
			};
			const results = runtime.resolveTaskTypesForStep(step);
			expect(results).toHaveLength(3);
			expect(results[0]).toEqual({ taskType: 'planning', customAgentId: undefined });
			expect(results[1]).toEqual({ taskType: 'coding', customAgentId: undefined });
			expect(results[2]).toEqual({ taskType: 'coding', customAgentId: AGENT_CUSTOM });
		});

		test('multi-agent step with general role → coding, no customAgentId', () => {
			const step = {
				id: STEP_A,
				name: 'Multi',
				agents: [{ agentId: AGENT_GENERAL }, { agentId: AGENT_CODER }],
			};
			const results = runtime.resolveTaskTypesForStep(step);
			expect(results).toHaveLength(2);
			expect(results[0]).toEqual({ taskType: 'coding', customAgentId: undefined });
			expect(results[1]).toEqual({ taskType: 'coding', customAgentId: undefined });
		});

		test('multi-agent step with unknown agentId → coding + customAgentId preserved', () => {
			const step = {
				id: STEP_A,
				name: 'Multi',
				agents: [{ agentId: AGENT_CODER }, { agentId: 'unknown-agent-id' }],
			};
			const results = runtime.resolveTaskTypesForStep(step);
			expect(results).toHaveLength(2);
			expect(results[0]).toEqual({ taskType: 'coding', customAgentId: undefined });
			expect(results[1]).toEqual({ taskType: 'coding', customAgentId: 'unknown-agent-id' });
		});

		test('resolveTaskTypeForStep delegates to first entry of resolveTaskTypesForStep', () => {
			const step = {
				id: STEP_A,
				name: 'Multi',
				agents: [{ agentId: AGENT_PLANNER }, { agentId: AGENT_CODER }],
			};
			const single = runtime.resolveTaskTypeForStep(step);
			const multi = runtime.resolveTaskTypesForStep(step);
			expect(single).toEqual(multi[0]);
			expect(single.taskType).toBe('planning');
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

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'My Run');

			expect(tasks).toHaveLength(1);
			const task = tasks[0];
			expect(task.workflowRunId).toBe(run.id);
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

		test('propagates workflow maxIterations to the created run', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `MaxIter Test ${Date.now()}`,
				description: 'Test',
				steps: [{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER }],
				transitions: [],
				startStepId: STEP_A,
				rules: [],
				tags: [],
				maxIterations: 3,
			});

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(run.maxIterations).toBe(3);
		});

		test('uses default maxIterations when workflow has none', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(run.maxIterations).toBe(5);
		});

		test('throws for unknown workflow', async () => {
			await expect(runtime.startWorkflowRun(SPACE_ID, 'nonexistent-wf-id', 'Run')).rejects.toThrow(
				'Workflow not found'
			);
		});

		test('cancels DB run record when task creation fails (prevents silent rehydration loop)', async () => {
			// Create a workflow where the startStepId references a valid step but the
			// agentId references an agent that is then deleted, causing createTask to fail
			// due to the foreign key constraint on space_tasks.agent_id.
			// Instead, use FK-bypass to create a workflow with a bogus startStepId to
			// trigger the "Start step not found" path which also exercises the cleanup.
			db.exec('PRAGMA foreign_keys = OFF');
			let workflow: SpaceWorkflow;
			try {
				const repo = new SpaceWorkflowRepository(db);
				workflow = repo.createWorkflow({
					spaceId: SPACE_ID,
					name: `Broken Start ${Date.now()}`,
					description: '',
					steps: [{ id: 'step-bad', name: 'Step', agentId: AGENT_PLANNER }],
					transitions: [],
					startStepId: 'nonexistent-start-step-id',
					rules: [],
					tags: [],
				});
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}

			// Count runs before
			const runsBefore = workflowRunRepo.listBySpace(SPACE_ID);

			await expect(runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Bad Run')).rejects.toThrow(
				'Start step'
			);

			// The newly created run should be cancelled, not left as in_progress
			const runsAfter = workflowRunRepo.listBySpace(SPACE_ID);
			const newRun = runsAfter.find((r) => !runsBefore.some((b) => b.id === r.id));
			expect(newRun).toBeDefined();
			expect(newRun!.status).toBe('cancelled');

			// Executor map should not retain the failed run
			expect(runtime.executorCount).toBe(0);
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

		test('stores goalId on run record and propagates to initial task', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(
				SPACE_ID,
				workflow.id,
				'Goal Run',
				undefined,
				'goal-abc'
			);

			expect(run.goalId).toBe('goal-abc');
			expect(tasks[0].goalId).toBe('goal-abc');
		});

		test('goalId defaults to undefined when not provided', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'No Goal');

			expect(run.goalId).toBeUndefined();
			expect(tasks[0].goalId).toBeUndefined();
		});

		test('multi-agent start step: creates one task per agent', async () => {
			// Workflow with agents[] format: planner first, then coder.
			// startWorkflowRun creates one pending SpaceTask per agent entry.
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi-Agent Start ${Date.now()}`,
				description: '',
				steps: [
					{
						id: STEP_A,
						name: 'Multi Step',
						agents: [{ agentId: AGENT_PLANNER }, { agentId: AGENT_CODER }],
					},
				],
				transitions: [],
				startStepId: STEP_A,
				rules: [],
				tags: [],
			});

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Multi Run');

			// One task per agent — planner task and coder task created in parallel
			expect(tasks).toHaveLength(2);
			const plannerTask = tasks.find((t) => t.taskType === 'planning');
			const coderTask = tasks.find((t) => t.taskType === 'coding');
			expect(plannerTask).toBeDefined();
			expect(plannerTask!.customAgentId).toBeUndefined();
			expect(coderTask).toBeDefined();
			expect(coderTask!.customAgentId).toBeUndefined();
		});

		test('multi-agent start step with custom-role first agent: sets customAgentId', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi-Agent Custom ${Date.now()}`,
				description: '',
				steps: [
					{
						id: STEP_A,
						name: 'Custom Multi Step',
						agents: [{ agentId: AGENT_CUSTOM }, { agentId: AGENT_CODER }],
					},
				],
				transitions: [],
				startStepId: STEP_A,
				rules: [],
				tags: [],
			});

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Custom Multi Run');

			expect(tasks[0].taskType).toBe('coding');
			expect(tasks[0].customAgentId).toBe(AGENT_CUSTOM);
		});

		test('cancels run and clears executor when start step has no agent configuration', async () => {
			// Bypass FK + manager validation to insert a step with no agentId/agents
			db.exec('PRAGMA foreign_keys = OFF');
			let workflow: SpaceWorkflow;
			try {
				const repo = new SpaceWorkflowRepository(db);
				// Insert step JSON directly with no agentId and no agents[]
				workflow = repo.createWorkflow({
					spaceId: SPACE_ID,
					name: `No Agent Step ${Date.now()}`,
					description: '',
					steps: [{ id: STEP_A, name: 'Broken Step' } as never],
					transitions: [],
					startStepId: STEP_A,
					rules: [],
					tags: [],
				});
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}

			const runsBefore = workflowRunRepo.listBySpace(SPACE_ID);

			await expect(runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Broken Run')).rejects.toThrow();

			// Run should be cancelled, executor map should be clean
			const runsAfter = workflowRunRepo.listBySpace(SPACE_ID);
			const newRun = runsAfter.find((r) => !runsBefore.some((b) => b.id === r.id));
			expect(newRun).toBeDefined();
			expect(newRun!.status).toBe('cancelled');
			expect(runtime.executorCount).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// goalId propagation through workflow advancement
	// -------------------------------------------------------------------------

	describe('goalId propagation through workflow advancement', () => {
		test('goalId propagates to tasks created by followTransition on advance', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(
				SPACE_ID,
				workflow.id,
				'Goal Propagation Run',
				undefined,
				'goal-propagate'
			);

			// Initial task should have goalId
			expect(tasks[0].goalId).toBe('goal-propagate');

			// Complete step A → tick → step B task created with goalId
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });
			await runtime.executeTick();

			const allTasks = taskRepo.listByWorkflowRun(run.id);
			expect(allTasks).toHaveLength(2);

			const stepBTask = allTasks.find((t) => t.workflowStepId === STEP_B);
			expect(stepBTask).toBeDefined();
			expect(stepBTask!.goalId).toBe('goal-propagate');
		});

		test('goalId propagates through all steps of a three-step workflow', async () => {
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

			const { run, tasks } = await runtime.startWorkflowRun(
				SPACE_ID,
				workflow.id,
				'Full Goal Run',
				undefined,
				'goal-full'
			);

			// Complete step A → tick
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });
			await runtime.executeTick();

			// Complete step B → tick
			const stepBTask = taskRepo
				.listByWorkflowRun(run.id)
				.find((t) => t.workflowStepId === STEP_B)!;
			taskRepo.updateTask(stepBTask.id, { status: 'completed' });
			await runtime.executeTick();

			// All three tasks should have the goalId
			const allTasks = taskRepo.listByWorkflowRun(run.id);
			expect(allTasks).toHaveLength(3);
			for (const task of allTasks) {
				expect(task.goalId).toBe('goal-full');
			}
		});

		test('tasks have no goalId when run has no goalId', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'No Goal Run');

			// Complete step A → tick
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });
			await runtime.executeTick();

			const allTasks = taskRepo.listByWorkflowRun(run.id);
			for (const task of allTasks) {
				expect(task.goalId).toBeUndefined();
			}
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
	// Non-gate error propagation
	// -------------------------------------------------------------------------

	describe('non-gate error propagation', () => {
		/**
		 * Creates a workflow directly via the repository (bypassing manager validation)
		 * with a transition whose target step does not exist in the workflow's step list.
		 * When advance() is called, followTransition() throws a non-gate Error.
		 *
		 * FK checks are temporarily disabled to allow the broken transition row to be
		 * inserted. They are always re-enabled in a finally block.
		 */
		function buildWorkflowWithBrokenTransition(stepId: string, stepName: string): SpaceWorkflow {
			db.exec('PRAGMA foreign_keys = OFF');
			try {
				const repo = new SpaceWorkflowRepository(db);
				return repo.createWorkflow({
					spaceId: SPACE_ID,
					name: `Broken ${Date.now()}-${Math.random()}`,
					description: '',
					steps: [{ id: stepId, name: stepName, agentId: AGENT_PLANNER }],
					transitions: [
						{ from: stepId, to: 'ghost-step-that-does-not-exist', condition: { type: 'always' } },
					],
					startStepId: stepId,
					rules: [],
					tags: [],
				});
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}
		}

		test('executeTick() re-throws non-WorkflowGateError from a run tick', async () => {
			// Use a workflow with a broken transition so advance() throws a non-gate Error:
			// "Target step 'ghost-step-that-does-not-exist' not found in workflow ..."
			const workflow = buildWorkflowWithBrokenTransition('step-err1', 'Plan');

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await expect(runtime.executeTick()).rejects.toThrow();
		});

		test('processRunTick cancels and removes run when currentStepId is inconsistent with workflow', async () => {
			// Create a valid workflow and start a run normally
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(runtime.executorCount).toBe(1);

			// Externally corrupt the run's currentStepId to a step that doesn't exist
			// in the workflow (simulates data inconsistency, e.g. a workflow was updated
			// after a run was started).
			workflowRunRepo.updateRun(run.id, { currentStepId: 'step-that-does-not-exist' });

			// executeTick() should throw (data inconsistency error), but also:
			// 1. cancel the DB run record so it is not rehydrated on next restart
			// 2. remove the executor and meta from the in-memory maps
			await expect(runtime.executeTick()).rejects.toThrow('not found in workflow');

			const updatedRun = workflowRunRepo.getRun(run.id)!;
			expect(updatedRun.status).toBe('cancelled');
			expect(runtime.executorCount).toBe(0);
			expect(runtime.getExecutor(run.id)).toBeUndefined();
		});

		test('executeTick() processes remaining runs after one run throws a non-gate error', async () => {
			// Run 1: broken transition → advance() will throw a non-gate error
			const wf1 = buildWorkflowWithBrokenTransition('step-err2', 'Plan Broken');
			// Run 2: normal single-step workflow (terminal step → completes immediately)
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-err3', name: 'Only Step', agentId: AGENT_PLANNER },
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

			// Complete both initial tasks
			taskRepo.updateTask(tasks1[0].id, { status: 'completed' });
			taskRepo.updateTask(tasks2[0].id, { status: 'completed' });

			// The tick should throw (from run1's broken transition) but still process run2
			await expect(runtime.executeTick()).rejects.toThrow();

			// run2 should have completed despite run1's error
			const run2State = workflowRunRepo.getRun(run2.id)!;
			expect(run2State.status).toBe('completed');
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

		test('rehydrates needs_attention runs so they can resume after gate resolved', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'human' }]
			);

			// Simulate a run that was blocked at a human gate before restart
			const pendingRun = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Gate Run',
				currentStepId: STEP_A,
			});
			const run = workflowRunRepo.updateStatus(pendingRun.id, 'needs_attention')!;
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Plan',
				description: '',
				workflowRunId: run.id,
				workflowStepId: STEP_A,
				status: 'completed',
			});

			// Fresh runtime rehydrates the needs_attention run
			const freshRuntime = new SpaceRuntime({
				db,
				spaceManager,
				spaceAgentManager: agentManager,
				spaceWorkflowManager: workflowManager,
				workflowRunRepo,
				taskRepo,
			});

			// First tick: rehydrates executor but run is needs_attention — no advancement
			await freshRuntime.executeTick();
			expect(freshRuntime.getExecutor(run.id)).toBeDefined();
			expect(workflowRunRepo.getRun(run.id)!.status).toBe('needs_attention');

			// Resolve the gate externally
			workflowRunRepo.updateRun(run.id, {
				status: 'in_progress',
				config: { humanApproved: true },
			});

			// Second tick: gate now passes, run advances to step B
			await freshRuntime.executeTick();

			const stepBTask = taskRepo.listByWorkflowRun(run.id).find((t) => t.workflowStepId === STEP_B);
			expect(stepBTask).toBeDefined();
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
	// Task Agent integration (taskAgentManager configured)
	// -------------------------------------------------------------------------

	describe('Task Agent integration', () => {
		/**
		 * Minimal mock for TaskAgentManager — only implements the methods that
		 * SpaceRuntime calls: isSpawning(), isTaskAgentAlive(), spawnTaskAgent(), rehydrate().
		 *
		 * The default spawnTaskAgent mirrors the real TaskAgentManager's DB side-effect:
		 * it writes taskAgentSessionId to the task row. SpaceRuntime relies on this
		 * contract and only writes status: 'in_progress' itself. If this side-effect
		 * were absent, the liveness check (Step 1) would never fire for the task.
		 */
		function makeMockTaskAgentManager(
			overrides: {
				isSpawning?: (taskId: string) => boolean;
				isTaskAgentAlive?: (taskId: string) => boolean;
				spawnTaskAgent?: (task: unknown) => Promise<string>;
				rehydrate?: () => Promise<void>;
			} = {}
		) {
			const spawned: string[] = [];
			return {
				isSpawning: overrides.isSpawning ?? (() => false),
				isTaskAgentAlive: overrides.isTaskAgentAlive ?? (() => false),
				spawnTaskAgent:
					overrides.spawnTaskAgent ??
					(async (task: unknown) => {
						const t = task as { id: string };
						spawned.push(t.id);
						// Mirror real TaskAgentManager: writes taskAgentSessionId as a side-effect
						taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
						return `session:${t.id}`;
					}),
				rehydrate: overrides.rehydrate ?? (async () => {}),
				_spawned: spawned,
			};
		}

		function buildRuntimeWithMockTAM(
			tam: ReturnType<typeof makeMockTaskAgentManager>,
			overrideSpaceManager?: {
				getSpace: (id: string) => Promise<unknown>;
				listSpaces: () => Promise<unknown[]>;
			}
		) {
			return new SpaceRuntime({
				db,
				spaceManager: (overrideSpaceManager ?? spaceManager) as never,
				spaceAgentManager: agentManager,
				spaceWorkflowManager: workflowManager,
				workflowRunRepo,
				taskRepo,
				taskAgentManager: tam as never,
			});
		}

		test('spawns Task Agent for pending task when taskAgentManager is configured', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const tam = makeMockTaskAgentManager();
			const rt = buildRuntimeWithMockTAM(tam);

			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks[0].status).toBe('pending');

			await rt.executeTick();

			// Task Agent should have been spawned
			expect(tam._spawned).toContain(tasks[0].id);
			// Task should be in_progress
			const updated = taskRepo.getTask(tasks[0].id)!;
			expect(updated.status).toBe('in_progress');
			expect(updated.taskAgentSessionId).toBe(`session:${tasks[0].id}`);
		});

		test('preserves direct advance() when taskAgentManager is NOT configured', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			// No taskAgentManager — runtime is the plain one from beforeEach
			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await runtime.executeTick();

			// Step B task should have been created by direct advance()
			const allTasks = taskRepo.listByWorkflowRun(run.id);
			expect(allTasks).toHaveLength(2);
			expect(allTasks.find((t) => t.workflowStepId === STEP_B)).toBeDefined();
		});

		test('skips tick when Task Agent is alive (in_progress task with taskAgentSessionId)', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			let spawnCount = 0;
			const tam = makeMockTaskAgentManager({
				isTaskAgentAlive: () => true, // always alive
				spawnTaskAgent: async (task: unknown) => {
					const t = task as { id: string };
					spawnCount++;
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				},
			});
			const rt = buildRuntimeWithMockTAM(tam);

			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// First tick: spawns Task Agent (no taskAgentSessionId yet)
			await rt.executeTick();
			expect(spawnCount).toBe(1);

			// Mark task as in_progress (set by SpaceRuntime after spawn)
			// taskAgentSessionId is already set by mock spawnTaskAgent
			const taskAfterSpawn = taskRepo.getTask(tasks[0].id)!;
			expect(taskAfterSpawn.taskAgentSessionId).toBeTruthy();

			// Subsequent ticks: agent is alive → skip, no re-spawn
			await rt.executeTick();
			await rt.executeTick();
			expect(spawnCount).toBe(1); // still only spawned once
		});

		test('does NOT advance when Task Agent mode is active (never calls advance())', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const tam = makeMockTaskAgentManager({
				isTaskAgentAlive: () => false, // appears dead after spawn (returns false after 1st call)
			});
			const rt = buildRuntimeWithMockTAM(tam);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Mark task as completed — in TAM mode, advance() should NOT be called
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await rt.executeTick();

			// No step B task should exist — SpaceRuntime never calls advance() in TAM mode
			const allTasks = taskRepo.listByWorkflowRun(run.id);
			expect(allTasks).toHaveLength(1);
			expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
		});

		test('detects crashed Task Agent and resets task to pending for re-spawn', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			let callCount = 0;
			const tam = makeMockTaskAgentManager({
				isTaskAgentAlive: () => false, // agent always reports as dead
				spawnTaskAgent: async (task: unknown) => {
					const t = task as { id: string };
					callCount++;
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}:v${callCount}` });
					return `session:${t.id}:v${callCount}`;
				},
			});
			const rt = buildRuntimeWithMockTAM(tam);

			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Manually set taskAgentSessionId to simulate a previously spawned (now dead) agent
			taskRepo.updateTask(tasks[0].id, {
				taskAgentSessionId: 'session:dead',
				status: 'in_progress',
			});

			// Tick: detect dead agent → reset to pending → spawn new agent
			await rt.executeTick();

			// Task should be in_progress with a fresh session
			const updated = taskRepo.getTask(tasks[0].id)!;
			expect(updated.status).toBe('in_progress');
			expect(updated.taskAgentSessionId).toBe(`session:${tasks[0].id}:v1`);
			expect(callCount).toBe(1); // spawned once for recovery
		});

		test('concurrency guard: isSpawning() prevents duplicate spawns during concurrent ticks', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			let spawnCount = 0;
			const spawningSet = new Set<string>();
			const tam = makeMockTaskAgentManager({
				isSpawning: (taskId: string) => spawningSet.has(taskId),
				spawnTaskAgent: async (task: unknown) => {
					const t = task as { id: string };
					spawnCount++;
					spawningSet.add(t.id);
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					spawningSet.delete(t.id);
					return `session:${t.id}`;
				},
			});
			const rt = buildRuntimeWithMockTAM(tam);

			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Simulate concurrent tick while first is "spawning"
			spawningSet.add(tasks[0].id); // pretend spawn is in progress

			await rt.executeTick();

			// No additional spawn should happen while isSpawning() returns true
			expect(spawnCount).toBe(0);
		});

		test('idempotent spawn: pending task without taskAgentSessionId only spawns once per tick', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
				{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
			]);

			let spawnCount = 0;
			const tam = makeMockTaskAgentManager({
				isTaskAgentAlive: (taskId: string) => {
					// Alive after spawn (taskAgentSessionId is set)
					const task = taskRepo.getTask(taskId);
					return !!task?.taskAgentSessionId;
				},
				spawnTaskAgent: async (task: unknown) => {
					const t = task as { id: string };
					spawnCount++;
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				},
			});
			const rt = buildRuntimeWithMockTAM(tam);

			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Multiple ticks — should only spawn once (agent is alive after first spawn)
			await rt.executeTick();
			await rt.executeTick();
			await rt.executeTick();

			expect(spawnCount).toBe(1);
			// Task should still be in_progress
			expect(taskRepo.getTask(tasks[0].id)!.status).toBe('in_progress');
		});

		test('new pending task from next workflow step gets a fresh Task Agent spawned', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const spawnedTasks: string[] = [];
			const tam = makeMockTaskAgentManager({
				isTaskAgentAlive: (taskId: string) => {
					const task = taskRepo.getTask(taskId);
					return !!task?.taskAgentSessionId;
				},
				spawnTaskAgent: async (task: unknown) => {
					const t = task as { id: string };
					spawnedTasks.push(t.id);
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				},
			});
			const rt = buildRuntimeWithMockTAM(tam);

			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Tick 1: spawns Task Agent for step A
			await rt.executeTick();
			expect(spawnedTasks).toContain(tasks[0].id);

			// Simulate Task Agent completing step A:
			// - calls advance_workflow → creates step B task (pending, no taskAgentSessionId)
			// - calls report_result → marks step A task as completed
			// - advance() creates the step B task and advances the run's currentStepId
			taskRepo.updateTask(tasks[0].id, { status: 'completed', taskAgentSessionId: null });
			// Manually call advance to simulate Task Agent's advance_workflow tool
			await rt.getExecutor(run.id)!.advance();

			const stepBTask = taskRepo.listByWorkflowRun(run.id).find((t) => t.workflowStepId === STEP_B);
			expect(stepBTask).toBeDefined();

			// Tick 2: should spawn Task Agent for step B
			await rt.executeTick();
			expect(spawnedTasks).toContain(stepBTask!.id);
		});

		test('logs warning and skips spawn when space is null (space deleted mid-run)', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			// Start the run with the real space manager so startWorkflowRun() works.
			const tam = makeMockTaskAgentManager({
				spawnTaskAgent: async (task: unknown) => {
					const t = task as { id: string };
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				},
			});
			const realRt = buildRuntimeWithMockTAM(tam);
			const { tasks } = await realRt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			let spawnCount = 0;
			const tamForNull = makeMockTaskAgentManager({
				spawnTaskAgent: async (task: unknown) => {
					const t = task as { id: string };
					spawnCount++;
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				},
			});

			// Build a fresh runtime that uses a null space manager for getSpace().
			// startWorkflowRun already created the run and executor in the DB; the fresh
			// runtime rehydrates it on first executeTick() and then hits the null space path.
			const nullSpaceManager = {
				getSpace: async () => null,
				listSpaces: async () => [{ id: SPACE_ID, workspacePath: WORKSPACE }],
			};
			const rtWithNullSpace = buildRuntimeWithMockTAM(tamForNull, nullSpaceManager);

			// executeTick() rehydrates the run but getSpace() returns null → spawn skipped
			await rtWithNullSpace.executeTick();

			// No Task Agent spawned — space is null
			expect(spawnCount).toBe(0);
			// Task stays pending
			expect(taskRepo.getTask(tasks[0].id)!.status).toBe('pending');
		});

		test('liveness loop resets all dead-agent tasks before deciding to skip tick', async () => {
			// Two tasks for the same step: task A alive, task B dead.
			// The dead-agent reset for task B must still happen even though task A is alive.
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const tam = makeMockTaskAgentManager({
				isTaskAgentAlive: (taskId: string) => taskId === 'task-alive',
			});
			const rt = buildRuntimeWithMockTAM(tam);

			const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Insert a second task for the same step directly via repo (multi-task scenario)
			const taskB = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Plan B',
				description: '',
				workflowRunId: run.id,
				workflowStepId: STEP_A,
				status: 'in_progress',
			});

			// Simulate: task B has a dead agent session; we override its id to match mock
			// Use DB update + a custom tam that keys liveness by taskId
			const taskBId = taskB.id;
			taskRepo.updateTask(taskBId, { taskAgentSessionId: 'session:dead-b' });

			// Create alive task separately by injecting its id into the mock
			const firstTask = taskRepo.listByWorkflowRun(run.id).find((t) => t.id !== taskBId)!;
			taskRepo.updateTask(firstTask.id, {
				taskAgentSessionId: 'session:alive-a',
				status: 'in_progress',
			});

			// Override the mock to know which task is alive
			const aliveId = firstTask.id;
			const customTam = makeMockTaskAgentManager({
				isTaskAgentAlive: (taskId: string) => taskId === aliveId,
			});
			const rt2 = buildRuntimeWithMockTAM(customTam);

			await rt2.executeTick();

			// Dead task B should have been reset to pending (dead-agent recovery happened)
			const updatedB = taskRepo.getTask(taskBId)!;
			expect(updatedB.status).toBe('pending');
			expect(updatedB.taskAgentSessionId).toBeFalsy(); // cleared (null stored as undefined by repo)

			// Alive task A should be untouched
			const updatedA = taskRepo.getTask(aliveId)!;
			expect(updatedA.status).toBe('in_progress');
			expect(updatedA.taskAgentSessionId).toBe('session:alive-a');
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

	// -------------------------------------------------------------------------
	// Multi-agent steps
	// -------------------------------------------------------------------------

	describe('multi-agent step support', () => {
		test('startWorkflowRun() creates multiple tasks for multi-agent start step', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi-Agent Start ${Date.now()}`,
				steps: [
					{
						id: STEP_A,
						name: 'Parallel Start',
						agents: [
							{ agentId: AGENT_CODER, instructions: 'Coder task' },
							{ agentId: AGENT_PLANNER, instructions: 'Planner task' },
						],
					},
				],
				transitions: [],
				startStepId: STEP_A,
				rules: [],
				tags: [],
			});

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(tasks).toHaveLength(2);
			for (const task of tasks) {
				expect(task.workflowRunId).toBe(run.id);
				expect(task.workflowStepId).toBe(STEP_A);
				expect(task.status).toBe('pending');
			}

			// Descriptions set from per-agent instructions
			const descriptions = tasks.map((t) => t.description).sort();
			expect(descriptions).toEqual(['Coder task', 'Planner task'].sort());
		});

		test('startWorkflowRun() uses agentId shorthand for single-agent start step (backward compat)', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Start', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(tasks).toHaveLength(1);
			expect(tasks[0].workflowStepId).toBe(STEP_A);
		});

		test('startWorkflowRun() applies per-agent taskType for multi-agent start step', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi-Agent TaskType ${Date.now()}`,
				steps: [
					{
						id: STEP_A,
						name: 'Mixed Start',
						agents: [{ agentId: AGENT_PLANNER }, { agentId: AGENT_CODER }],
					},
				],
				transitions: [],
				startStepId: STEP_A,
				rules: [],
				tags: [],
			});

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(tasks).toHaveLength(2);

			const plannerTask = tasks.find((t) => t.taskType === 'planning');
			const coderTask = tasks.find((t) => t.taskType === 'coding');

			expect(plannerTask).toBeDefined();
			expect(plannerTask!.customAgentId).toBeUndefined();

			expect(coderTask).toBeDefined();
			expect(coderTask!.customAgentId).toBeUndefined();
		});

		test('executeTick() does NOT advance when only some parallel tasks are completed', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Partial Complete ${Date.now()}`,
				steps: [
					{
						id: STEP_A,
						name: 'Parallel A',
						agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_PLANNER }],
					},
					{ id: STEP_B, name: 'Step B', agentId: AGENT_CODER },
				],
				transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
				startStepId: STEP_A,
				rules: [],
				tags: [],
			});

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks).toHaveLength(2);

			// Only complete one of the two parallel tasks
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });
			// tasks[1] stays pending

			await runtime.executeTick();

			// No new task for STEP_B should have been created
			const allTasks = taskRepo.listByWorkflowRun(run.id);
			const stepBTasks = allTasks.filter((t) => t.workflowStepId === STEP_B);
			expect(stepBTasks).toHaveLength(0);
		});

		test('executeTick() advances when ALL parallel tasks are completed', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `All Complete ${Date.now()}`,
				steps: [
					{
						id: STEP_A,
						name: 'Parallel A',
						agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_PLANNER }],
					},
					{ id: STEP_B, name: 'Step B', agentId: AGENT_CODER },
				],
				transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
				startStepId: STEP_A,
				rules: [],
				tags: [],
			});

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks).toHaveLength(2);

			// Complete both parallel tasks
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });
			taskRepo.updateTask(tasks[1].id, { status: 'completed' });

			await runtime.executeTick();

			// Step B task should now exist
			const allTasks = taskRepo.listByWorkflowRun(run.id);
			const stepBTasks = allTasks.filter((t) => t.workflowStepId === STEP_B);
			expect(stepBTasks).toHaveLength(1);
		});

		test('executeTick() marks run as needs_attention when all parallel tasks terminal and any failed', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Partial Failure ${Date.now()}`,
				steps: [
					{
						id: STEP_A,
						name: 'Parallel Fail',
						agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_PLANNER }],
					},
				],
				transitions: [],
				startStepId: STEP_A,
				rules: [],
				tags: [],
			});

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks).toHaveLength(2);

			// One task completes, one fails — both terminal
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });
			taskRepo.updateTask(tasks[1].id, { status: 'needs_attention', error: 'Build failed' });

			await runtime.executeTick();

			const updatedRun = workflowRunRepo.getRun(run.id)!;
			expect(updatedRun.status).toBe('needs_attention');
		});

		test('executeTick() does NOT mark run needs_attention when parallel tasks are not all terminal yet', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Partial Terminal ${Date.now()}`,
				steps: [
					{
						id: STEP_A,
						name: 'Parallel Waiting',
						agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_PLANNER }],
					},
				],
				transitions: [],
				startStepId: STEP_A,
				rules: [],
				tags: [],
			});

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks).toHaveLength(2);

			// One task fails, one is still running
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Fail' });
			taskRepo.updateTask(tasks[1].id, { status: 'in_progress' });

			await runtime.executeTick();

			// Run should still be in_progress — sibling task is still running
			const updatedRun = workflowRunRepo.getRun(run.id)!;
			expect(updatedRun.status).toBe('in_progress');
		});

		test('resolveTaskTypeForAgent() returns correct mapping for each role', () => {
			expect(runtime.resolveTaskTypeForAgent(AGENT_PLANNER)).toEqual({
				taskType: 'planning',
				customAgentId: undefined,
			});
			expect(runtime.resolveTaskTypeForAgent(AGENT_CODER)).toEqual({
				taskType: 'coding',
				customAgentId: undefined,
			});
			expect(runtime.resolveTaskTypeForAgent(AGENT_GENERAL)).toEqual({
				taskType: 'coding',
				customAgentId: undefined,
			});
			expect(runtime.resolveTaskTypeForAgent(AGENT_CUSTOM)).toEqual({
				taskType: 'coding',
				customAgentId: AGENT_CUSTOM,
			});
		});

		test('resolveTaskTypeForAgent() returns custom coding agent for unknown agentId', () => {
			const result = runtime.resolveTaskTypeForAgent('unknown-agent-id');
			expect(result.taskType).toBe('coding');
			expect(result.customAgentId).toBe('unknown-agent-id');
		});
	});

	// -------------------------------------------------------------------------
	// Channel topology resolution
	// -------------------------------------------------------------------------

	describe('channel topology resolution', () => {
		test('storeResolvedChannels: step with channels stores resolved channels in run config', async () => {
			// Need two agents with different roles for channel resolution
			const AGENT_REVIEWER = 'agent-reviewer';
			seedAgentRow(db, AGENT_REVIEWER, SPACE_ID, 'Reviewer', 'reviewer');

			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Channel Step ${Date.now()}`,
				steps: [
					{
						id: STEP_A,
						name: 'Code and Review',
						agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_REVIEWER }],
						channels: [
							{
								from: 'coder',
								to: 'reviewer',
								direction: 'one-way',
								label: 'submit',
							},
						],
					},
				],
				transitions: [],
				startStepId: STEP_A,
				rules: [],
				tags: [],
			});

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Run config should contain resolved channels
			const updatedRun = workflowRunRepo.getRun(run.id)!;
			const resolvedChannels = (updatedRun.config as Record<string, unknown>)?._resolvedChannels;
			expect(Array.isArray(resolvedChannels)).toBe(true);
			expect((resolvedChannels as unknown[]).length).toBeGreaterThan(0);
		});

		test('storeResolvedChannels: step without channels does not modify run config', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'No Channels', agentId: AGENT_CODER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Run config should NOT have _resolvedChannels
			const updatedRun = workflowRunRepo.getRun(run.id)!;
			const resolvedChannels = (updatedRun.config as Record<string, unknown> | undefined)
				?._resolvedChannels;
			expect(resolvedChannels).toBeUndefined();
		});
	});
});
