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
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
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
	nodes: Array<{ id: string; name: string; agentId: string; instructions?: string }>,
	conditions: Array<{ type: 'always' | 'human'; description?: string }> = []
): SpaceWorkflow {
	// Build transitions: step[i] → step[i+1] with conditions[i]
	const transitions = nodes.slice(0, -1).map((step, i) => ({
		from: step.id,
		to: nodes[i + 1].id,
		condition: conditions[i] ?? { type: 'always' as const },
		order: 0,
	}));

	return workflowManager.createWorkflow({
		spaceId,
		name: `Test Workflow ${Date.now()}-${Math.random()}`,
		description: 'Test',
		nodes,
		transitions,
		startNodeId: nodes[0].id,
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
				agents: [
					{ agentId: AGENT_PLANNER, name: 'planner' },
					{ agentId: AGENT_CODER, name: 'coder' },
					{ agentId: AGENT_CUSTOM, name: 'my-custom-role' },
				],
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
				agents: [
					{ agentId: AGENT_GENERAL, name: 'general' },
					{ agentId: AGENT_CODER, name: 'coder' },
				],
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
				agents: [
					{ agentId: AGENT_CODER, name: 'coder' },
					{ agentId: 'unknown-agent-id', name: 'unknown' },
				],
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
				agents: [
					{ agentId: AGENT_PLANNER, name: 'planner' },
					{ agentId: AGENT_CODER, name: 'coder' },
				],
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
				nodes: [{ id: STEP_A, name: 'Step A', agentId: AGENT_CODER }],
				transitions: [],
				startNodeId: STEP_A,
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
				nodes: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_PLANNER },
				],
				transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
				startNodeId: STEP_A,
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
		});

		test('creates initial SpaceTask for the start step', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'My Run');

			expect(tasks).toHaveLength(1);
			const task = tasks[0];
			expect(task.workflowRunId).toBe(run.id);
			expect(task.workflowNodeId).toBe(STEP_A);
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
				nodes: [{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER }],
				transitions: [],
				startNodeId: STEP_A,
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
			// Create a workflow where the startNodeId references a valid node but the
			// agentId references an agent that is then deleted, causing createTask to fail
			// due to the foreign key constraint on space_tasks.agent_id.
			// Instead, use FK-bypass to create a workflow with a bogus startNodeId to
			// trigger the "Start node not found" path which also exercises the cleanup.
			db.exec('PRAGMA foreign_keys = OFF');
			let workflow: SpaceWorkflow;
			try {
				const repo = new SpaceWorkflowRepository(db);
				workflow = repo.createWorkflow({
					spaceId: SPACE_ID,
					name: `Broken Start ${Date.now()}`,
					description: '',
					nodes: [{ id: 'step-bad', name: 'Step', agentId: AGENT_PLANNER }],
					transitions: [],
					startNodeId: 'nonexistent-start-step-id',
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
				nodes: [
					{
						id: STEP_A,
						name: 'Multi Step',
						agents: [
							{ agentId: AGENT_PLANNER, name: 'planner' },
							{ agentId: AGENT_CODER, name: 'coder' },
						],
					},
				],
				transitions: [],
				startNodeId: STEP_A,
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
				nodes: [
					{
						id: STEP_A,
						name: 'Custom Multi Step',
						agents: [
							{ agentId: AGENT_CUSTOM, name: 'my-custom-role' },
							{ agentId: AGENT_CODER, name: 'coder' },
						],
					},
				],
				transitions: [],
				startNodeId: STEP_A,
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
					nodes: [{ id: STEP_A, name: 'Broken Step' } as never],
					transitions: [],
					startNodeId: STEP_A,
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
	});

	// -------------------------------------------------------------------------
	// Rehydration
	// -------------------------------------------------------------------------

	describe('rehydrateExecutors()', () => {
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
			});
			workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');

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
		test('cleanupTerminalExecutors() removes cancelled runs', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(runtime.executorCount).toBe(1);

			// Externally cancel the run
			workflowRunRepo.transitionStatus(run.id, 'cancelled');

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

		test('crashed Task Agent resets to pending on first crash (retry) then needs_attention after max retries', async () => {
			// M9.4 crash-retry: transient crashes reset to pending (up to MAX_TASK_AGENT_CRASH_RETRIES=2).
			// Only after the limit is exhausted does the task escalate to needs_attention.
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			let spawnCount = 0;
			const tam = makeMockTaskAgentManager({
				isTaskAgentAlive: () => false, // agent always reports as dead (crashed)
				spawnTaskAgent: async (task: unknown) => {
					const t = task as { id: string };
					spawnCount++;
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}:v${spawnCount}` });
					return `session:${t.id}:v${spawnCount}`;
				},
			});
			const rt = buildRuntimeWithMockTAM(tam);

			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Manually set taskAgentSessionId to simulate a previously spawned (now crashed) agent
			taskRepo.updateTask(tasks[0].id, {
				taskAgentSessionId: 'session:dead',
				status: 'in_progress',
			});

			// Tick 1: crash 1 (count=1 ≤ MAX=2) → reset to pending; runtime re-spawns in same tick
			await rt.executeTick();
			let updated = taskRepo.getTask(tasks[0].id)!;
			expect(updated.status).toBe('in_progress'); // re-spawned after first crash
			expect(spawnCount).toBe(1);

			// Tick 2: crash 2 (count=2 ≤ MAX=2) → reset to pending; runtime re-spawns in same tick
			await rt.executeTick();
			updated = taskRepo.getTask(tasks[0].id)!;
			expect(updated.status).toBe('in_progress'); // re-spawned after second crash
			expect(spawnCount).toBe(2);

			// Tick 3: crash 3 (count=3 > MAX=2) → needs_attention, no further re-spawn
			await rt.executeTick();
			updated = taskRepo.getTask(tasks[0].id)!;
			expect(updated.status).toBe('needs_attention');
			expect(updated.taskAgentSessionId == null).toBe(true);
			expect(updated.error).toContain('3 times');
			// Only 2 re-spawns happened (crashes 1 and 2 got retries; crash 3 escalated)
			expect(spawnCount).toBe(2);
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

		test('liveness loop resets crashed task to pending (1st crash) and leaves alive sibling untouched', async () => {
			// M9.4 crash-retry: Two tasks in same step — task A alive, task B crashed (1st crash).
			// Task B resets to pending for retry; task A (alive) remains untouched.
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
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});

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

			// Crashed task B: first crash → reset to pending, then immediately re-spawned in
			// the same tick's spawn step → in_progress with a new session. Not needs_attention.
			const updatedB = taskRepo.getTask(taskBId)!;
			expect(updatedB.status).toBe('in_progress');
			expect(updatedB.taskAgentSessionId).not.toBeNull(); // new session from re-spawn

			// Alive task A should be untouched
			const updatedA = taskRepo.getTask(aliveId)!;
			expect(updatedA.status).toBe('in_progress');
			expect(updatedA.taskAgentSessionId).toBe('session:alive-a');
		});

		test('liveness loop marks crashed task needs_attention after max retries exhausted', async () => {
			// After MAX_TASK_AGENT_CRASH_RETRIES=2 retries, the 3rd crash escalates to needs_attention.
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			let spawnCount = 0;
			const aliveIds = new Set<string>();
			const tam = makeMockTaskAgentManager({
				isTaskAgentAlive: (taskId: string) => aliveIds.has(taskId),
				spawnTaskAgent: async (task: unknown) => {
					const t = task as { id: string };
					spawnCount++;
					const sessionId = `session:${t.id}:v${spawnCount}`;
					taskRepo.updateTask(t.id, { taskAgentSessionId: sessionId });
					// Keep alive until next tick check
					return sessionId;
				},
			});
			const rt = buildRuntimeWithMockTAM(tam);
			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Pre-load with a dead session to trigger crash detection from tick 1
			taskRepo.updateTask(tasks[0].id, {
				taskAgentSessionId: 'session:dead-initial',
				status: 'in_progress',
			});

			// 3 ticks: crash 1 → pending+respawn, crash 2 → pending+respawn, crash 3 → needs_attention
			await rt.executeTick();
			await rt.executeTick();
			await rt.executeTick();

			const updated = taskRepo.getTask(tasks[0].id)!;
			expect(updated.status).toBe('needs_attention');
			expect(updated.taskAgentSessionId == null).toBe(true);
			expect(updated.error).toContain('3 times');
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

			// Four built-in workflows should exist
			const workflows = workflowManager.listWorkflows(newSpaceId);
			expect(workflows).toHaveLength(4);
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
			expect(workflows).toHaveLength(4); // still 4, not 8
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
				nodes: [
					{
						id: STEP_A,
						name: 'Parallel Start',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder', instructions: 'Coder task' },
							{ agentId: AGENT_PLANNER, name: 'planner', instructions: 'Planner task' },
						],
					},
				],
				transitions: [],
				startNodeId: STEP_A,
				rules: [],
				tags: [],
			});

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(tasks).toHaveLength(2);
			for (const task of tasks) {
				expect(task.workflowRunId).toBe(run.id);
				expect(task.workflowNodeId).toBe(STEP_A);
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
			expect(tasks[0].workflowNodeId).toBe(STEP_A);
		});

		test('startWorkflowRun() applies per-agent taskType for multi-agent start step', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi-Agent TaskType ${Date.now()}`,
				nodes: [
					{
						id: STEP_A,
						name: 'Mixed Start',
						agents: [
							{ agentId: AGENT_PLANNER, name: 'planner' },
							{ agentId: AGENT_CODER, name: 'coder' },
						],
					},
				],
				transitions: [],
				startNodeId: STEP_A,
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
				nodes: [
					{
						id: STEP_A,
						name: 'Parallel A',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_PLANNER, name: 'planner' },
						],
					},
					{ id: STEP_B, name: 'Step B', agentId: AGENT_CODER },
				],
				transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
				startNodeId: STEP_A,
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
			const stepBTasks = allTasks.filter((t) => t.workflowNodeId === STEP_B);
			expect(stepBTasks).toHaveLength(0);
		});

		test('executeTick() marks run as needs_attention when all parallel tasks terminal and any failed', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Partial Failure ${Date.now()}`,
				nodes: [
					{
						id: STEP_A,
						name: 'Parallel Fail',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_PLANNER, name: 'planner' },
						],
					},
				],
				transitions: [],
				startNodeId: STEP_A,
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
				nodes: [
					{
						id: STEP_A,
						name: 'Parallel Waiting',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_PLANNER, name: 'planner' },
						],
					},
				],
				transitions: [],
				startNodeId: STEP_A,
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
				nodes: [
					{
						id: STEP_A,
						name: 'Code and Review',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_REVIEWER, name: 'reviewer' },
						],
					},
				],
				channels: [
					{
						from: 'coder',
						to: 'reviewer',
						direction: 'one-way',
						label: 'submit',
					},
				],
				transitions: [],
				startNodeId: STEP_A,
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

		test('storeResolvedChannels: step without channels does NOT store task-agent channels', async () => {
			// When a step has no user-declared channels, no channels should be stored.
			// M3 auto-generation of task-agent channels has been removed.
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'No Channels', agentId: AGENT_CODER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Run config should have _resolvedChannels set to empty (no auto-add)
			const updatedRun = workflowRunRepo.getRun(run.id)!;
			const resolvedChannels = (updatedRun.config as Record<string, unknown> | undefined)
				?._resolvedChannels as Array<Record<string, unknown>> | undefined;
			// Should be empty array when no user-declared channels exist
			expect(Array.isArray(resolvedChannels)).toBe(true);
			expect(resolvedChannels.length).toBe(0);
		});

		test('storeResolvedChannels: no auto-generated channels when step has multiple agents with the same role', async () => {
			// When a step has no user-declared channels, no channels should be stored,
			// even if the step has multiple agents with the same role.
			// M3 auto-generation has been removed.
			const AGENT_CODER_2 = 'agent-coder-2-duplicate-role';
			seedAgentRow(db, AGENT_CODER_2, SPACE_ID, 'Coder 2', 'coder');

			const stepId = `step-dedup-${Date.now()}`;
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'Duplicate Role Test',
				nodes: [
					{
						id: stepId,
						name: 'Two Coders Same Role',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_CODER_2, name: 'coder-2' },
						],
					},
				],
				transitions: [],
				startNodeId: stepId,
				rules: [],
			});

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			const updatedRun = workflowRunRepo.getRun(run.id)!;
			const resolvedChannels = (updatedRun.config as Record<string, unknown> | undefined)
				?._resolvedChannels as Array<Record<string, unknown>> | undefined;
			expect(Array.isArray(resolvedChannels)).toBe(true);
			// No auto-generated channels when no user-declared channels exist
			expect(resolvedChannels.length).toBe(0);
		});
	});
});
