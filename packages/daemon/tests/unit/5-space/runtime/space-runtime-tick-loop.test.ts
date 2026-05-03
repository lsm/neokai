/**
 * SpaceRuntime — Tick Loop Correctness Tests
 *
 * Covers tick loop behaviors NOT covered by the main space-runtime.test.ts:
 * - Tick picks up tasks from new workflow runs created between ticks
 * - Multiple ticks do not duplicate executors for the same run
 * - Tick processes multiple independent workflow runs in the same tick
 * - processCompletedTasks error isolation (one bad run doesn't starve others)
 * - Executor creation failure during rehydration is handled gracefully
 * - cleanupTerminalExecutors removes 'done' runs (not just cancelled)
 * - start()/stop() lifecycle: timer management, idempotent start, stop clears timer
 * - Tick spawns agents for tasks added to an existing run between ticks
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
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
import type { SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	// Use in-memory SQLite — faster than file-based DB and avoids filesystem
	// I/O contention that caused beforeEach hook timeouts in CI.
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return db;
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
		completionAutonomyLevel: 3,
	});
}

// ---------------------------------------------------------------------------
// Mock TaskAgentManager factory
// ---------------------------------------------------------------------------

function makeMockTaskAgentManager(
	taskRepo: SpaceTaskRepository,
	nodeExecutionRepo: NodeExecutionRepository,
	overrides: {
		isSpawning?: (taskId: string) => boolean;
		isTaskAgentAlive?: (taskId: string) => boolean;
		spawnWorkflowNodeAgent?: (task: unknown) => Promise<string>;
		isExecutionSpawning?: (executionId: string) => boolean;
		isSessionAlive?: (sessionId: string) => boolean;
		spawnWorkflowNodeAgentForExecution?: (
			task: unknown,
			space: unknown,
			workflow: unknown,
			run: unknown,
			execution: unknown
		) => Promise<string>;
		rehydrate?: () => Promise<void>;
		cancelBySessionId?: (sessionId: string) => void;
		interruptBySessionId?: (sessionId: string) => Promise<void>;
		getAgentSessionById?: (sessionId: string) => unknown;
	} = {}
) {
	const spawned: string[] = [];
	const sessionToTask = new Map<string, string>();
	const spawnExecutionImpl =
		overrides.spawnWorkflowNodeAgentForExecution ??
		(async (
			task: unknown,
			_space: unknown,
			_workflow: unknown,
			_run: unknown,
			execution: unknown
		) => {
			if (overrides.spawnWorkflowNodeAgent) {
				const legacySessionId = await overrides.spawnWorkflowNodeAgent(task);
				const t = task as { id?: string };
				const e = execution as { id?: string };
				if (t.id && legacySessionId) sessionToTask.set(legacySessionId, t.id);
				if (t.id) spawned.push(t.id);
				if (e.id) {
					nodeExecutionRepo.update(e.id, {
						status: 'in_progress',
						agentSessionId: legacySessionId,
						startedAt: Date.now(),
						completedAt: null,
					});
				}
				return legacySessionId;
			}
			const e = execution as { id?: string };
			const t = task as { id?: string };
			const executionId = e.id ?? t.id ?? `exec-${Math.random().toString(36).slice(2)}`;
			const taskId = t.id ?? executionId;
			const sessionId = `session:${executionId}`;
			sessionToTask.set(sessionId, taskId);
			spawned.push(taskId);
			if (e.id) {
				nodeExecutionRepo.update(e.id, {
					status: 'in_progress',
					agentSessionId: sessionId,
					startedAt: Date.now(),
					completedAt: null,
				});
			}
			return sessionId;
		});
	const spawnImpl =
		overrides.spawnWorkflowNodeAgent ??
		(async (task: unknown) => {
			const t = task as { id: string };
			spawned.push(t.id);
			taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
			sessionToTask.set(`session:${t.id}`, t.id);
			return `session:${t.id}`;
		});
	return {
		isSpawning: overrides.isSpawning ?? (() => false),
		isTaskAgentAlive: overrides.isTaskAgentAlive ?? (() => false),
		spawnWorkflowNodeAgent: spawnImpl,
		isExecutionSpawning: overrides.isExecutionSpawning ?? (() => false),
		isSessionAlive:
			overrides.isSessionAlive ??
			((sessionId: string) => {
				if (!overrides.isTaskAgentAlive) return false;
				const taskId = sessionToTask.get(sessionId);
				return taskId ? overrides.isTaskAgentAlive(taskId) : false;
			}),
		spawnWorkflowNodeAgentForExecution: spawnExecutionImpl,
		rehydrate: overrides.rehydrate ?? (async () => {}),
		cancelBySessionId: overrides.cancelBySessionId ?? (() => {}),
		interruptBySessionId: overrides.interruptBySessionId ?? (async () => {}),
		getAgentSessionById: overrides.getAgentSessionById ?? (() => null),
		// PR 3/5 added a post-approval awareness injection via
		// `injectIntoTaskAgent`. The tick-loop mock is not exercising delivery,
		// so return a trivial "not injected" result — production treats this as
		// best-effort anyway.
		injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
		_spawned: spawned,
	};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SpaceRuntime — tick loop correctness', () => {
	// Covers the per-tick scheduling/dispatch loop and approval → router
	// hand-off. The legacy approval→done dispatch path was removed in PR 4/5;
	// `dispatchPostApproval` is the only route now.

	let db: BunDatabase;

	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let nodeExecutionRepo: NodeExecutionRepository;

	const SPACE_ID = 'space-tick-1';
	const SPACE_ID_2 = 'space-tick-2';
	const WORKSPACE = '/tmp/tick-ws';

	const AGENT_PLANNER = 'agent-planner';
	const AGENT_CODER = 'agent-coder';

	const STEP_A = 'step-a';
	const STEP_B = 'step-b';

	beforeEach(() => {
		db = makeDb();

		seedSpaceRow(db, SPACE_ID, WORKSPACE);
		seedSpaceRow(db, SPACE_ID_2, '/tmp/tick-ws-2');
		seedAgentRow(db, AGENT_PLANNER, SPACE_ID, 'Planner');
		seedAgentRow(db, AGENT_CODER, SPACE_ID, 'Coder');
		// Seed agents in second space too
		seedAgentRow(db, `${AGENT_PLANNER}-s2`, SPACE_ID_2, 'Planner');
		seedAgentRow(db, `${AGENT_CODER}-s2`, SPACE_ID_2, 'Coder');

		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);

		spaceManager = new SpaceManager(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
		} catch {
			/* ignore */
		}
	});

	function buildConfig(tam?: ReturnType<typeof makeMockTaskAgentManager>): SpaceRuntimeConfig {
		return {
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			taskAgentManager: tam as never,
		};
	}

	// -------------------------------------------------------------------------
	// Tick picks up new tasks with workflow runs
	// -------------------------------------------------------------------------

	describe('tick picks up new tasks from workflow runs', () => {
		test('tick spawns agent for task created by startWorkflowRun before first tick', async () => {
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
			const rt = new SpaceRuntime(buildConfig(tam));

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(tasks[0].status).toBe('open');

			// First tick picks up the pending task and spawns agent
			await rt.executeTick();

			expect(tam._spawned).toContain(tasks[0].id);
			const updated = taskRepo.getTask(tasks[0].id)!;
			expect(updated.status).toBe('in_progress');
		});

		test('tick picks up workflow run created between ticks', async () => {
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: (taskId: string) => {
					const task = taskRepo.getTask(taskId);
					return !!task?.taskAgentSessionId;
				},
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			// First tick — no runs yet
			await rt.executeTick();
			expect(tam._spawned).toHaveLength(0);

			// Create a workflow run between ticks
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Late Run');

			// Second tick picks up the new run's task
			await rt.executeTick();

			expect(tam._spawned).toContain(tasks[0].id);
			expect(taskRepo.getTask(tasks[0].id)!.status).toBe('in_progress');
		});

		test('tick picks up tasks added to an existing run between ticks', async () => {
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: (taskId: string) => {
					const task = taskRepo.getTask(taskId);
					return !!task?.taskAgentSessionId;
				},
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
				{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
			]);
			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// First tick spawns agent for first task
			await rt.executeTick();
			expect(tam._spawned).toContain(tasks[0].id);
			const firstSpawnCount = tam._spawned.length;

			// Simulate a new task being added to the same run (e.g., by channel activation)
			const newTask = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Code',
				description: '',
				workflowRunId: run.id,
				status: 'open',
			});
			nodeExecutionRepo.createOrIgnore({
				workflowRunId: run.id,
				workflowNodeId: STEP_B,
				agentName: newTask.title,
				agentId: AGENT_CODER,
				status: 'pending',
			});

			// Second tick picks up the new task
			await rt.executeTick();
			expect(tam._spawned.length).toBeGreaterThan(firstSpawnCount);
			expect(taskRepo.getTask(tasks[0].id)!.status).toBe('in_progress');
			expect(taskRepo.getTask(newTask.id)!.status).toBe('archived');
		});
	});

	// -------------------------------------------------------------------------
	// Multiple ticks do not duplicate executors
	// -------------------------------------------------------------------------

	describe('multiple ticks do not duplicate executors', () => {
		test('executor count stays 1 after multiple ticks for the same active run', async () => {
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: () => true,
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			await rt.executeTick();
			expect(rt.executorCount).toBe(1);

			await rt.executeTick();
			expect(rt.executorCount).toBe(1);

			await rt.executeTick();
			expect(rt.executorCount).toBe(1);
		});

		test('two different runs produce exactly two executors across multiple ticks', async () => {
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: () => true,
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
			]);

			const { run: run1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
			const { run: run2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

			await rt.executeTick();
			expect(rt.executorCount).toBe(2);
			expect(rt.getExecutor(run1.id)).toBeDefined();
			expect(rt.getExecutor(run2.id)).toBeDefined();

			await rt.executeTick();
			expect(rt.executorCount).toBe(2);
		});
	});

	// -------------------------------------------------------------------------
	// Tick skips already-running tasks
	// -------------------------------------------------------------------------

	describe('tick skips already-running tasks', () => {
		test('in_progress task with alive agent is not re-spawned', async () => {
			let spawnCount = 0;
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: () => true,
				spawnWorkflowNodeAgent: async (task: unknown) => {
					const t = task as { id: string };
					spawnCount++;
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				},
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// First tick spawns
			await rt.executeTick();
			expect(spawnCount).toBe(1);

			// Subsequent ticks skip alive agent
			await rt.executeTick();
			await rt.executeTick();
			await rt.executeTick();
			expect(spawnCount).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// processCompletedTasks error isolation
	// -------------------------------------------------------------------------

	describe('processCompletedTasks error isolation', () => {
		test('error in one run does not prevent processing the other run', async () => {
			// Strategy: create two runs with the real spaceManager, then build a
			// fresh runtime with a faulty spaceManager that throws for SPACE_ID.
			// The fresh runtime rehydrates both runs on first tick, then
			// processRunTick throws for run1 but succeeds for run2.
			const spawned: string[] = [];
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: (taskId: string) => {
					const task = taskRepo.getTask(taskId);
					return !!task?.taskAgentSessionId;
				},
				spawnWorkflowNodeAgent: async (task: unknown) => {
					const t = task as { id: string };
					spawned.push(t.id);
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				},
			});

			// Create runs with real spaceManager so startWorkflowRun succeeds
			const realRt = new SpaceRuntime(buildConfig(tam));
			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID_2, workflowManager, [
				{ id: STEP_B, name: 'Code', agentId: `${AGENT_CODER}-s2` },
			]);
			await realRt.startWorkflowRun(SPACE_ID, wf1.id, 'Failing Run');
			const { tasks: tasks2 } = await realRt.startWorkflowRun(SPACE_ID_2, wf2.id, 'Good Run');

			// Now build a fresh runtime with a faulty spaceManager
			const faultySpaceManager = {
				getSpace: async (id: string) => {
					if (id === SPACE_ID) {
						throw new Error('Simulated DB corruption for space-tick-1');
					}
					return spaceManager.getSpace(id);
				},
				listSpaces: async () => spaceManager.listSpaces(false),
			};
			const faultyRt = new SpaceRuntime({
				...buildConfig(tam),
				spaceManager: faultySpaceManager as never,
			});

			// executeTick rehydrates both runs, then processRunTick throws for run1
			// but continues to process run2. Re-throws the first error at the end.
			await expect(faultyRt.executeTick()).rejects.toThrow('Simulated DB corruption');

			// The good run's task was spawned successfully despite the sibling error
			expect(spawned).toContain(tasks2[0].id);
			expect(taskRepo.getTask(tasks2[0].id)!.status).toBe('in_progress');
		});

		test('first error is re-thrown after all runs are processed', async () => {
			// Create two runs with real spaceManager first
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
			const realRt = new SpaceRuntime(buildConfig(tam));

			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
			]);
			await realRt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
			await realRt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

			// Build fresh runtime with getSpace that always throws
			const faultySpaceManager = {
				getSpace: async () => {
					throw new Error('getSpace always fails');
				},
				listSpaces: async () => spaceManager.listSpaces(false),
			};
			const faultyRt = new SpaceRuntime({
				...buildConfig(tam),
				spaceManager: faultySpaceManager as never,
			});

			// Both runs error, but executeTick re-throws (first error only)
			// after processing all runs — it doesn't bail on the first error.
			await expect(faultyRt.executeTick()).rejects.toThrow('getSpace always fails');

			// Both executors are still in the map (error doesn't remove them)
			expect(faultyRt.executorCount).toBe(2);
		});
	});

	// -------------------------------------------------------------------------
	// Executor creation failure during rehydration
	// -------------------------------------------------------------------------

	describe('rehydration graceful failure handling', () => {
		test('rehydration skips run whose workflow was deleted (no throw)', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			// Create a run directly via repo
			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Orphan Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Delete the workflow — rehydration should skip this run
			workflowManager.deleteWorkflow(workflow.id);

			const freshRt = new SpaceRuntime(buildConfig());
			await expect(freshRt.executeTick()).resolves.toBeUndefined();
			expect(freshRt.executorCount).toBe(0);
		});

		test('rehydration does not duplicate executors on second tick', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);

			// Create a run that will be rehydrated
			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Rehydrate Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Also create a task for it
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Plan',
				description: '',
				workflowRunId: run.id,
				status: 'open',
			});

			const freshRt = new SpaceRuntime(buildConfig());

			// First tick triggers rehydration
			await freshRt.executeTick();
			expect(freshRt.executorCount).toBe(1);

			// Second tick does NOT re-rehydrate
			await freshRt.executeTick();
			expect(freshRt.executorCount).toBe(1);
		});

		test('rehydration loads runs from multiple spaces', async () => {
			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID_2, workflowManager, [
				{ id: STEP_B, name: 'Code', agentId: `${AGENT_CODER}-s2` },
			]);

			const run1 = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: wf1.id,
				title: 'Run S1',
			});
			workflowRunRepo.transitionStatus(run1.id, 'in_progress');

			const run2 = workflowRunRepo.createRun({
				spaceId: SPACE_ID_2,
				workflowId: wf2.id,
				title: 'Run S2',
			});
			workflowRunRepo.transitionStatus(run2.id, 'in_progress');

			const freshRt = new SpaceRuntime(buildConfig());
			await freshRt.executeTick();

			expect(freshRt.executorCount).toBe(2);
			expect(freshRt.getExecutor(run1.id)).toBeDefined();
			expect(freshRt.getExecutor(run2.id)).toBeDefined();
		});
	});

	// -------------------------------------------------------------------------
	// cleanupTerminalExecutors for 'done' runs
	// -------------------------------------------------------------------------

	describe('cleanupTerminalExecutors', () => {
		test('removes executor for done run', async () => {
			const rt = new SpaceRuntime(buildConfig());

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(rt.executorCount).toBe(1);

			// Mark run as done externally
			workflowRunRepo.transitionStatus(run.id, 'done');

			await rt.executeTick();

			expect(rt.getExecutor(run.id)).toBeUndefined();
			expect(rt.executorCount).toBe(0);
		});

		test('removes executor for cancelled run', async () => {
			const rt = new SpaceRuntime(buildConfig());

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(rt.executorCount).toBe(1);

			workflowRunRepo.transitionStatus(run.id, 'cancelled');

			await rt.executeTick();

			expect(rt.getExecutor(run.id)).toBeUndefined();
			expect(rt.executorCount).toBe(0);
		});

		test('removes executor when run record is deleted from DB', async () => {
			const rt = new SpaceRuntime(buildConfig());

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			expect(rt.executorCount).toBe(1);
			for (const task of taskRepo.listByWorkflowRun(run.id)) {
				taskRepo.updateTask(task.id, { status: 'done' });
			}

			// Delete the run record entirely
			db.prepare('DELETE FROM space_workflow_runs WHERE id = ?').run(run.id);

			await rt.executeTick();

			expect(rt.getExecutor(run.id)).toBeUndefined();
			expect(rt.executorCount).toBe(0);
		});

		test('cleanupTerminalExecutors leaves in_progress runs alone', async () => {
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: () => true,
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
			]);

			const { run: run1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
			const { run: run2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

			// Cancel run1, leave run2 in_progress
			workflowRunRepo.transitionStatus(run1.id, 'cancelled');

			await rt.executeTick();

			expect(rt.getExecutor(run1.id)).toBeUndefined();
			expect(rt.getExecutor(run2.id)).toBeDefined();
			expect(rt.executorCount).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Multiple independent workflow runs processed in same tick
	// -------------------------------------------------------------------------

	describe('multiple independent workflow runs in same tick', () => {
		test('tick spawns agents for tasks across multiple runs', async () => {
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: (taskId: string) => {
					const task = taskRepo.getTask(taskId);
					return !!task?.taskAgentSessionId;
				},
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
			]);

			const { tasks: tasks1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
			const { tasks: tasks2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

			// Single tick spawns agents for both runs
			await rt.executeTick();

			expect(tam._spawned).toContain(tasks1[0].id);
			expect(tam._spawned).toContain(tasks2[0].id);

			expect(taskRepo.getTask(tasks1[0].id)!.status).toBe('in_progress');
			expect(taskRepo.getTask(tasks2[0].id)!.status).toBe('in_progress');
		});

		test('one run completing does not affect sibling run processing', async () => {
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: () => true,
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
			]);

			const { run: run1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
			const { run: run2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

			// Tick to spawn both
			await rt.executeTick();
			expect(rt.executorCount).toBe(2);

			// Complete run1 externally
			workflowRunRepo.transitionStatus(run1.id, 'done');

			// Next tick cleans up run1, keeps run2
			await rt.executeTick();

			expect(rt.getExecutor(run1.id)).toBeUndefined();
			expect(rt.getExecutor(run2.id)).toBeDefined();
			expect(rt.executorCount).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// start() / stop() lifecycle
	// -------------------------------------------------------------------------

	describe('start() / stop() lifecycle', () => {
		test('start() is idempotent — calling twice does not create duplicate timers', async () => {
			// Intercept setInterval to count how many timers are created
			const origSetInterval = globalThis.setInterval;
			let intervalCount = 0;
			globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
				intervalCount++;
				return origSetInterval(...args);
			}) as typeof setInterval;

			try {
				const rt = new SpaceRuntime(buildConfig());
				rt.start();
				rt.start(); // second call should be no-op

				// Only one interval should have been created
				expect(intervalCount).toBe(1);
				await rt.stop();
			} finally {
				globalThis.setInterval = origSetInterval;
			}
		});

		test('stop() clears the timer — clearInterval is called', async () => {
			// Use a deterministic approach: intercept clearInterval to verify it's called
			const origClearInterval = globalThis.clearInterval;
			let clearCalled = false;
			globalThis.clearInterval = ((...args: Parameters<typeof clearInterval>) => {
				clearCalled = true;
				return origClearInterval(...args);
			}) as typeof clearInterval;

			try {
				const rt = new SpaceRuntime(buildConfig());
				rt.start();
				expect(clearCalled).toBe(false);

				await rt.stop();
				expect(clearCalled).toBe(true);
			} finally {
				globalThis.clearInterval = origClearInterval;
			}
		});

		test('stop() when not started is a no-op', async () => {
			const rt = new SpaceRuntime(buildConfig());

			// Should not throw
			await expect(rt.stop()).resolves.toBeUndefined();
		});

		test('start() can be called again after stop() — creates a new timer', async () => {
			const origSetInterval = globalThis.setInterval;
			let intervalCount = 0;
			globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
				intervalCount++;
				return origSetInterval(...args);
			}) as typeof setInterval;

			try {
				const rt = new SpaceRuntime(buildConfig());

				rt.start();
				expect(intervalCount).toBe(1);

				await rt.stop();

				// Restart — should create a new interval
				rt.start();
				expect(intervalCount).toBe(2);

				await rt.stop();
			} finally {
				globalThis.setInterval = origSetInterval;
			}
		});
	});

	// -------------------------------------------------------------------------
	// Spawn failure handling
	// -------------------------------------------------------------------------

	describe('tick handles spawn failure gracefully', () => {
		test('spawn failure for one task does not prevent spawning another task', async () => {
			let callCount = 0;
			const spawned: string[] = [];
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: (taskId: string) => {
					const task = taskRepo.getTask(taskId);
					return !!task?.taskAgentSessionId;
				},
				spawnWorkflowNodeAgent: async (task: unknown) => {
					const t = task as { id: string };
					callCount++;
					if (callCount === 1) {
						throw new Error('Simulated spawn failure');
					}
					spawned.push(t.id);
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				},
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			// Create two separate workflow runs so tasks are processed in order
			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
			]);

			const { tasks: tasks1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
			const { tasks: tasks2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

			// Tick — first spawn fails, second should succeed
			await rt.executeTick();

			expect(callCount).toBe(2);
			// First task failed to spawn — run task remains in_progress while execution retries stay pending
			expect(taskRepo.getTask(tasks1[0].id)!.status).toBe('in_progress');
			// Second task should have been spawned successfully
			expect(spawned).toContain(tasks2[0].id);
			expect(taskRepo.getTask(tasks2[0].id)!.status).toBe('in_progress');
		});

		test('spawn failure keeps task in open status for retry on next tick', async () => {
			let failOnce = true;
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: (taskId: string) => {
					const task = taskRepo.getTask(taskId);
					return !!task?.taskAgentSessionId;
				},
				spawnWorkflowNodeAgent: async (task: unknown) => {
					const t = task as { id: string };
					if (failOnce) {
						failOnce = false;
						throw new Error('Transient failure');
					}
					taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
					return `session:${t.id}`;
				},
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// First tick — spawn fails, task stays open
			await rt.executeTick();
			const tasks = taskRepo.listByWorkflowRun(workflowRunRepo.listBySpace(SPACE_ID)[0].id);
			expect(tasks[0].status).toBe('in_progress');
			const runExecsAfterFail = nodeExecutionRepo.listByWorkflowRun(tasks[0].workflowRunId!);
			expect(runExecsAfterFail.some((exec) => exec.status === 'pending')).toBe(true);

			// Second tick — spawn succeeds (failOnce is now false)
			await rt.executeTick();
			const updated = taskRepo.getTask(tasks[0].id)!;
			expect(updated.status).toBe('in_progress');
			expect(updated.taskAgentSessionId).toBeTruthy();
		});
	});

	// -------------------------------------------------------------------------
	// Race condition: rehydration + fresh executor from startWorkflowRun
	// -------------------------------------------------------------------------

	describe('rehydration does not duplicate executors from startWorkflowRun', () => {
		test('startWorkflowRun before first tick — rehydration skips already-registered executor', async () => {
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				isTaskAgentAlive: () => true,
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
			]);
			const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// startWorkflowRun already registered the executor.
			// First executeTick triggers rehydration — should NOT duplicate.
			expect(rt.executorCount).toBe(1);

			await rt.executeTick();
			expect(rt.executorCount).toBe(1);
			expect(rt.getExecutor(run.id)).toBeDefined();
		});
	});

	// -------------------------------------------------------------------------
	// executeTick rehydration happens exactly once
	// -------------------------------------------------------------------------

	describe('rehydration happens exactly once', () => {
		test('rehydrate is called exactly once across multiple ticks', async () => {
			let rehydrateCount = 0;
			const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
				rehydrate: async () => {
					rehydrateCount++;
				},
				isTaskAgentAlive: () => true,
			});
			const rt = new SpaceRuntime(buildConfig(tam));

			await rt.executeTick();
			await rt.executeTick();
			await rt.executeTick();

			// TaskAgentManager.rehydrate() called exactly once (on the first tick)
			expect(rehydrateCount).toBe(1);
		});
	});
});
