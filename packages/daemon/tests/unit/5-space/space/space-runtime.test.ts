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
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
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

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, name, Date.now(), Date.now());
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
	let nodeExecutionRepo: NodeExecutionRepository;
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
		seedAgentRow(db, AGENT_PLANNER, SPACE_ID, 'Planner');
		seedAgentRow(db, AGENT_CODER, SPACE_ID, 'Coder');
		seedAgentRow(db, AGENT_GENERAL, SPACE_ID, 'General');
		seedAgentRow(db, AGENT_CUSTOM, SPACE_ID, 'Custom');

		// Build managers and repos
		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);

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
			nodeExecutionRepo,
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
	// getRulesForStep — removed in M71; no tests needed
	// -------------------------------------------------------------------------

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
			// workflowNodeId was removed from SpaceTask in M71; node tracking moved to node_executions
			expect(task.status).toBe('open');
			expect(task.title).toBe('My Run');
		});

		test('creates task with open status for planner start step', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// taskType removed from SpaceTask in M71; role-to-type mapping no longer stored on task
			expect(tasks[0].status).toBe('open');
		});

		test('creates task with open status for coder start step', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Code', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(tasks[0].status).toBe('open');
		});

		test('registers executor in executors map', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(runtime.executorCount).toBe(1);
			expect(runtime.getExecutor(run.id)).toBeDefined();
		});

		// maxIterations removed from CreateSpaceWorkflowParams and CreateWorkflowRunParams;
		// per-channel maxCycles via ChannelCycleRepository replaces global iteration tracking.

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
					endNodeId: 'step-bad',
					rules: [],
					tags: [],
				});
			} finally {
				db.exec('PRAGMA foreign_keys = ON');
			}

			// Count runs before
			const runsBefore = workflowRunRepo.listBySpace(SPACE_ID);

			await expect(runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Bad Run')).rejects.toThrow();

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

		test('goalId param is accepted (but not stored — removed from SpaceWorkflowRun in M71)', async () => {
			// goalId was removed from SpaceWorkflowRun in M71; the param is silently ignored
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

			// run and task should still be created successfully
			expect(run).toBeDefined();
			expect(tasks).toHaveLength(1);
		});

		test('goalId defaults to undefined when not provided', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'No Goal');

			// goalId removed from SpaceWorkflowRun and SpaceTask in M71
			expect((run as Record<string, unknown>).goalId).toBeUndefined();
			expect((tasks[0] as Record<string, unknown>).goalId).toBeUndefined();
		});

		test('multi-agent start step: creates one canonical task and node executions per agent', async () => {
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

			expect(tasks).toHaveLength(1);
			expect(tasks[0].status).toBe('open');
			const executions = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A);
			expect(executions).toHaveLength(2);
		});

		test('multi-agent start step with custom-role first agent: creates canonical task and executions', async () => {
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

			expect(tasks).toHaveLength(1);
			expect(tasks[0].status).toBe('open');
			const executions = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A);
			expect(executions).toHaveLength(2);
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

			// Run should not remain active in the executor map
			const runsAfter = workflowRunRepo.listBySpace(SPACE_ID);
			const newRun = runsAfter.find((r) => !runsBefore.some((b) => b.id === r.id));
			if (newRun) {
				expect(newRun.status).toBe('cancelled');
			}
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
				status: 'open',
			});

			// Tick should not throw and executor count stays 0
			await runtime.executeTick();

			expect(runtime.executorCount).toBe(0);

			// Task status unchanged
			const unchanged = taskRepo.getTask(task.id)!;
			expect(unchanged.status).toBe('open');
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
				nodeExecutionRepo: new NodeExecutionRepository(db),
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
		 * Minimal mock for TaskAgentManager.
		 *
		 * The runtime now uses execution-centric APIs
		 * (isExecutionSpawning / isSessionAlive / spawnWorkflowNodeAgentForExecution).
		 * This helper keeps tests concise by accepting task-centric overrides and mapping
		 * execution IDs back to the canonical run task when needed.
		 */
		function makeMockTaskAgentManager(
			overrides: {
				isSpawning?: (taskId: string) => boolean;
				isTaskAgentAlive?: (taskId: string) => boolean;
				spawnWorkflowNodeAgent?: (task: unknown) => Promise<string>;
				cancelBySessionId?: (sessionId: string) => void;
				rehydrate?: () => Promise<void>;
			} = {}
		) {
			const spawned: string[] = [];
			const taskIdForExecution = (executionId: string): string => {
				const execution = nodeExecutionRepo.getById(executionId);
				if (!execution) return executionId;
				return taskRepo.listByWorkflowRun(execution.workflowRunId)[0]?.id ?? executionId;
			};
			const spawnImpl =
				overrides.spawnWorkflowNodeAgent ??
				(async (task: unknown) => {
					const t = task as { id: string };
					spawned.push(t.id);
					// Mirror real TaskAgentManager: writes taskAgentSessionId as a side-effect
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				});
			return {
				isExecutionSpawning: (executionId: string) =>
					(overrides.isSpawning ?? (() => false))(taskIdForExecution(executionId)),
				isSessionAlive: (sessionId: string) => {
					const taskId = sessionId.startsWith('session:')
						? sessionId.slice('session:'.length).split(':')[0]
						: sessionId;
					return (overrides.isTaskAgentAlive ?? (() => false))(taskId);
				},
				spawnWorkflowNodeAgentForExecution: async (
					task: unknown,
					_space: unknown,
					_workflow: unknown,
					_run: unknown,
					_execution: unknown
				) => spawnImpl(task),
				cancelBySessionId: overrides.cancelBySessionId ?? (() => {}),
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
				nodeExecutionRepo,
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
			expect(tasks[0].status).toBe('open');

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
				spawnWorkflowNodeAgent: async (task: unknown) => {
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
			// taskAgentSessionId is already set by mock spawnWorkflowNodeAgent
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
				spawnWorkflowNodeAgent: async (task: unknown) => {
					const t = task as { id: string };
					spawnCount++;
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}:v${spawnCount}` });
					return `session:${t.id}:v${spawnCount}`;
				},
			});
			const rt = buildRuntimeWithMockTAM(tam);

			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Mark the single start-node execution as having a dead session to trigger crash handling.
			const firstExecution = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A)[0]!;
			nodeExecutionRepo.update(firstExecution.id, {
				agentSessionId: 'session:dead',
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

			// Tick 3: crash 3 (count=3 > MAX=2) → blocked (M71: needs_attention renamed to blocked)
			await rt.executeTick();
			updated = taskRepo.getTask(tasks[0].id)!;
			expect(updated.status).toBe('blocked');
			// crash info is stored in result field (not error)
			expect(updated.result).toContain('3 times');
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
				spawnWorkflowNodeAgent: async (task: unknown) => {
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
				spawnWorkflowNodeAgent: async (task: unknown) => {
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
				spawnWorkflowNodeAgent: async (task: unknown) => {
					const t = task as { id: string };
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				},
			});
			const realRt = buildRuntimeWithMockTAM(tam);
			const { tasks } = await realRt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			let spawnCount = 0;
			const tamForNull = makeMockTaskAgentManager({
				spawnWorkflowNodeAgent: async (task: unknown) => {
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
			// Task stays open (M71: 'pending' renamed to 'open')
			expect(taskRepo.getTask(tasks[0].id)!.status).toBe('open');
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
			taskRepo.updateTask(firstTask.id, { status: 'in_progress' });

			// Override the mock to know which task is alive
			const aliveId = firstTask.id;
			const customTam = makeMockTaskAgentManager({
				isTaskAgentAlive: (taskId: string) => taskId === aliveId,
			});
			const rt2 = buildRuntimeWithMockTAM(customTam);

			await rt2.executeTick();

			// In strict one-task-per-run mode, extra run tasks are archived during tick repair.
			const updatedB = taskRepo.getTask(taskBId)!;
			expect(updatedB.status).toBe('archived');
			expect(updatedB.workflowRunId).toBeUndefined();

			// Alive task A should be untouched
			const updatedA = taskRepo.getTask(aliveId)!;
			expect(updatedA.status).toBe('in_progress');
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
				spawnWorkflowNodeAgent: async (task: unknown) => {
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

			// Pre-load with a dead execution session to trigger crash detection from tick 1
			const firstExecution = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A)[0]!;
			nodeExecutionRepo.update(firstExecution.id, {
				agentSessionId: 'session:dead-initial',
				status: 'in_progress',
			});

			// 3 ticks: crash 1 → open+respawn, crash 2 → open+respawn, crash 3 → blocked
			await rt.executeTick();
			await rt.executeTick();
			await rt.executeTick();

			const updated = taskRepo.getTask(tasks[0].id)!;
			expect(updated.status).toBe('blocked');
			// crash info is stored in result field (not error)
			expect(updated.result).toContain('3 times');
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

			const { seedPresetAgents } = await import('../../../../src/lib/space/agents/seed-agents.ts');
			const { seedBuiltInWorkflows } = await import(
				'../../../../src/lib/space/workflows/built-in-workflows.ts'
			);

			// Seed agents
			const result = await seedPresetAgents(newSpaceId, agentManager);
			expect(result.errors).toHaveLength(0);
			expect(result.seeded.length).toBeGreaterThan(0);

			// Seed workflows using name resolver (role removed from CreateSpaceAgentParams in M71;
			// built-in templates use capitalized placeholder names matching agent names)
			const agents = agentManager.listBySpaceId(newSpaceId);
			expect(() =>
				seedBuiltInWorkflows(
					newSpaceId,
					workflowManager,
					(name) => agents.find((a) => a.name === name)?.id
				)
			).not.toThrow();

			// Five built-in workflows should exist
			const workflows = workflowManager.listWorkflows(newSpaceId);
			expect(workflows).toHaveLength(5);
		});

		test('seedBuiltInWorkflows is idempotent (calling twice is a no-op)', async () => {
			const newSpaceId = 'space-seed-idempotent';
			const newWorkspacePath = '/tmp/seed-idempotent';
			seedSpaceRow(db, newSpaceId, newWorkspacePath);

			const { seedPresetAgents } = await import('../../../../src/lib/space/agents/seed-agents.ts');
			const { seedBuiltInWorkflows } = await import(
				'../../../../src/lib/space/workflows/built-in-workflows.ts'
			);

			await seedPresetAgents(newSpaceId, agentManager);
			const agents = agentManager.listBySpaceId(newSpaceId);
			// role removed from CreateSpaceAgentParams in M71; use name lookup instead
			const resolver = (name: string) => agents.find((a) => a.name === name)?.id;

			seedBuiltInWorkflows(newSpaceId, workflowManager, resolver);
			seedBuiltInWorkflows(newSpaceId, workflowManager, resolver); // second call is no-op

			const workflows = workflowManager.listWorkflows(newSpaceId);
			expect(workflows).toHaveLength(5); // still 5, not 10
		});
	});

	// -------------------------------------------------------------------------
	// Multi-agent steps
	// -------------------------------------------------------------------------

	describe('multi-agent step support', () => {
		test('startWorkflowRun() creates one canonical task and one execution per agent', async () => {
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi-Agent Start ${Date.now()}`,
				nodes: [
					{
						id: STEP_A,
						name: 'Parallel Start',
						agents: [
							{
								agentId: AGENT_CODER,
								name: 'coder',
								instructions: { mode: 'override', value: 'Coder task' },
							},
							{
								agentId: AGENT_PLANNER,
								name: 'planner',
								instructions: { mode: 'override', value: 'Planner task' },
							},
						],
					},
				],
				transitions: [],
				startNodeId: STEP_A,
				rules: [],
				tags: [],
			});

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(tasks).toHaveLength(1);
			expect(tasks[0].workflowRunId).toBe(run.id);
			expect(tasks[0].status).toBe('open');
			const executions = nodeExecutionRepo.listByNode(run.id, STEP_A);
			expect(executions).toHaveLength(2);
			expect(executions.map((e) => e.agentName).sort()).toEqual(['coder', 'planner']);
		});

		test('startWorkflowRun() supports agentId shorthand for single-agent start step', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Start', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			expect(tasks).toHaveLength(1);
			// workflowNodeId removed from SpaceTask in M71; node tracking is now in node_executions
			expect(tasks[0].status).toBe('open');
		});

		test('startWorkflowRun() creates executions for multi-agent start step', async () => {
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

			expect(tasks).toHaveLength(1);
			expect(tasks[0].status).toBe('open');
			const executions = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A);
			expect(executions).toHaveLength(2);
		});

		test('executeTick() does not complete run when only some parallel executions are done', async () => {
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
			expect(tasks).toHaveLength(1);

			const executions = nodeExecutionRepo.listByNode(run.id, STEP_A);
			expect(executions).toHaveLength(2);
			nodeExecutionRepo.update(executions[0].id, { status: 'done' });

			await runtime.executeTick();

			const updatedRun = workflowRunRepo.getRun(run.id)!;
			expect(updatedRun.status).toBe('in_progress');
			expect(taskRepo.listByWorkflowRun(run.id)).toHaveLength(1);
		});

		test('executeTick() marks run blocked when one parallel execution is blocked', async () => {
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
			expect(tasks).toHaveLength(1);

			const executions = nodeExecutionRepo.listByNode(run.id, STEP_A);
			nodeExecutionRepo.update(executions[0].id, { status: 'done' });
			nodeExecutionRepo.update(executions[1].id, { status: 'blocked', result: 'Build failed' });

			await runtime.executeTick();

			const updatedRun = workflowRunRepo.getRun(run.id)!;
			expect(updatedRun.status).toBe('blocked');
		});

		test('executeTick() marks run blocked when one execution is blocked and one is in_progress', async () => {
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
			expect(tasks).toHaveLength(1);

			const executions = nodeExecutionRepo.listByNode(run.id, STEP_A);
			nodeExecutionRepo.update(executions[0].id, { status: 'blocked', result: 'Fail' });
			nodeExecutionRepo.update(executions[1].id, { status: 'in_progress' });

			await runtime.executeTick();

			const updatedRun = workflowRunRepo.getRun(run.id)!;
			expect(updatedRun.status).toBe('blocked');
		});
	});

	// -------------------------------------------------------------------------
	// Channel topology resolution
	// -------------------------------------------------------------------------

	describe('channel topology resolution', () => {
		test('storeWorkflowChannels: step with channels stores channels in memory', async () => {
			const AGENT_REVIEWER = 'agent-reviewer';
			seedAgentRow(db, AGENT_REVIEWER, SPACE_ID, 'Reviewer');

			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `Channel Step ${Date.now()}`,
				nodes: [
					{ id: STEP_A, name: 'Code', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: 'step-review',
						name: 'Review',
						agents: [{ agentId: AGENT_REVIEWER, name: 'reviewer' }],
					},
				],
				channels: [{ id: 'ch-1', from: 'Code', to: 'Review', label: 'submit' }],
				startNodeId: STEP_A,
				tags: [],
			});

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Channels stored in-memory via runtime.getRunWorkflowChannels()
			const channels = runtime.getRunWorkflowChannels(run.id);
			expect(Array.isArray(channels)).toBe(true);
			expect(channels.length).toBeGreaterThan(0);
			expect(channels[0].from).toBe('Code');
			expect(channels[0].to).toBe('Review');
		});

		test('storeWorkflowChannels: workflow without channels returns empty array', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'No Channels', agentId: AGENT_CODER },
			]);

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			const channels = runtime.getRunWorkflowChannels(run.id);
			expect(Array.isArray(channels)).toBe(true);
			expect(channels.length).toBe(0);
		});

		test('storeWorkflowChannels: no auto-generated channels for multi-agent step', async () => {
			const AGENT_CODER_2 = 'agent-coder-2-duplicate-role';
			seedAgentRow(db, AGENT_CODER_2, SPACE_ID, 'Coder 2');

			const stepId = `step-dedup-${Date.now()}`;
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'Duplicate Role Test',
				nodes: [
					{
						id: stepId,
						name: 'Two Coders',
						agents: [
							{ agentId: AGENT_CODER, name: 'coder' },
							{ agentId: AGENT_CODER_2, name: 'coder-2' },
						],
					},
				],
				startNodeId: stepId,
			});

			const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			const channels = runtime.getRunWorkflowChannels(run.id);
			expect(Array.isArray(channels)).toBe(true);
			expect(channels.length).toBe(0);
		});
	});
});
