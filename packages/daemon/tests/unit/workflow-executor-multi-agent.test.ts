/**
 * WorkflowExecutor — Multi-Agent Unit Tests
 *
 * Comprehensive tests for multi-agent workflow execution. Covers:
 *
 * 1.  advance() with multi-agent steps — multiple tasks created per step
 * 2.  startWorkflowRun() with multi-agent start step — multiple initial tasks
 * 3.  Step completion: does NOT advance when only some tasks complete
 * 4.  Step completion: DOES advance when ALL tasks complete
 * 5.  Parallel failure: one task fails, siblings still active → step waits
 * 6.  Partial failure — all terminal with one failed → run needs_attention
 * 7.  Backward compatibility: single agentId steps unchanged
 * 8.  resolveStepAgents() — utility function
 * 9.  resolveStepChannels() — all topology patterns
 * 10. Channel validation in persistence (SpaceWorkflowManager with agentLookup)
 * 11. Mixed workflows — some single-agent, some multi-agent, some with channels
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceAgentLookup } from '../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../src/lib/space/managers/space-task-manager.ts';
import { WorkflowExecutor } from '../../src/lib/space/runtime/workflow-executor.ts';
import type { CommandRunner } from '../../src/lib/space/runtime/workflow-executor.ts';
import { SpaceRuntime } from '../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../src/lib/space/runtime/space-runtime.ts';
import { WorkflowValidationError } from '../../src/lib/space/managers/space-workflow-manager.ts';
import { resolveStepAgents, resolveStepChannels } from '@neokai/shared';
import type { SpaceAgent, WorkflowStep } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-wf-multi-agent',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpace(db: BunDatabase, spaceId: string, workspacePath = '/tmp/ws'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, Date.now(), Date.now());
}

function seedAgent(
	db: BunDatabase,
	agentId: string,
	spaceId: string,
	name: string,
	role = 'coder'
): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt,
     config, created_at, updated_at, role)
     VALUES (?, ?, ?, '', null, '[]', '', null, ?, ?, ?)`
	).run(agentId, spaceId, name, Date.now(), Date.now(), role);
}

// ---------------------------------------------------------------------------
// Mock command runner
// ---------------------------------------------------------------------------

const makeOkRunner = (): CommandRunner => async () => ({ exitCode: 0 });

// ---------------------------------------------------------------------------
// Shared agent fixtures for resolveStepChannels tests
// ---------------------------------------------------------------------------

function makeSpaceAgent(id: string, role: string): SpaceAgent {
	return { id, spaceId: 'space-1', name: `${role} agent`, role, createdAt: 0, updatedAt: 0 };
}

// ===========================================================================
// WorkflowExecutor — advance() with multi-agent steps
// ===========================================================================

describe('WorkflowExecutor — advance() multi-agent', () => {
	let db: BunDatabase;
	let dir: string;
	let workflowRepo: SpaceWorkflowRepository;
	let runRepo: SpaceWorkflowRunRepository;
	let taskManager: SpaceTaskManager;

	const SPACE_ID = 'space-ma-1';
	const WORKSPACE = '/tmp/ws-ma';
	const AGENT_A = 'agent-ma-a';
	const AGENT_B = 'agent-ma-b';
	const AGENT_C = 'agent-ma-c';
	const STEP_START = 'step-start';
	const STEP_MULTI = 'step-multi';

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID, WORKSPACE);
		seedAgent(db, AGENT_A, SPACE_ID, 'Agent A', 'coder');
		seedAgent(db, AGENT_B, SPACE_ID, 'Agent B', 'reviewer');
		seedAgent(db, AGENT_C, SPACE_ID, 'Agent C', 'planner');

		workflowRepo = new SpaceWorkflowRepository(db);
		runRepo = new SpaceWorkflowRunRepository(db);
		taskManager = new SpaceTaskManager(db, SPACE_ID);
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
	// Subtask 2: advance() with multi-agent step creates multiple tasks
	// -------------------------------------------------------------------------

	test('creates one task per agent when agents[] has two entries', async () => {
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: `WF-2agent-${Date.now()}`,
			steps: [
				{ id: STEP_START, name: 'Start', agentId: AGENT_A },
				{
					id: STEP_MULTI,
					name: 'Parallel Step',
					agents: [{ agentId: AGENT_A }, { agentId: AGENT_B }],
				},
			],
			transitions: [{ from: STEP_START, to: STEP_MULTI, condition: { type: 'always' }, order: 0 }],
			startStepId: STEP_START,
		});
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Run',
			currentStepId: STEP_START,
		});
		const executor = new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			runRepo,
			WORKSPACE,
			makeOkRunner()
		);

		const result = await executor.advance();

		expect(result.step.id).toBe(STEP_MULTI);
		expect(result.tasks).toHaveLength(2);
	});

	test('all tasks from a multi-agent step share workflowRunId and workflowStepId', async () => {
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: `WF-shared-ids-${Date.now()}`,
			steps: [
				{ id: STEP_START, name: 'Start', agentId: AGENT_A },
				{
					id: STEP_MULTI,
					name: 'Parallel',
					agents: [{ agentId: AGENT_A }, { agentId: AGENT_B }],
				},
			],
			transitions: [{ from: STEP_START, to: STEP_MULTI, condition: { type: 'always' }, order: 0 }],
			startStepId: STEP_START,
		});
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Run',
			currentStepId: STEP_START,
		});
		const executor = new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			runRepo,
			WORKSPACE,
			makeOkRunner()
		);

		const { tasks } = await executor.advance();

		for (const task of tasks) {
			expect(task.workflowRunId).toBe(run.id);
			expect(task.workflowStepId).toBe(STEP_MULTI);
			expect(task.status).toBe('pending');
		}
	});

	test('per-agent instructions are used when provided; falls back to step instructions', async () => {
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: `WF-instructions-${Date.now()}`,
			steps: [
				{ id: STEP_START, name: 'Start', agentId: AGENT_A },
				{
					id: STEP_MULTI,
					name: 'Parallel',
					instructions: 'Shared fallback',
					agents: [
						{ agentId: AGENT_A, instructions: 'Agent A specific' },
						{ agentId: AGENT_B }, // no per-agent instructions → uses step.instructions
					],
				},
			],
			transitions: [{ from: STEP_START, to: STEP_MULTI, condition: { type: 'always' }, order: 0 }],
			startStepId: STEP_START,
		});
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Run',
			currentStepId: STEP_START,
		});
		const executor = new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			runRepo,
			WORKSPACE,
			makeOkRunner()
		);

		await executor.advance();

		const all = await taskManager.listTasksByWorkflowRun(run.id);
		const stepTasks = all.filter((t) => t.workflowStepId === STEP_MULTI);
		stepTasks.sort((a, b) => a.description.localeCompare(b.description));

		expect(stepTasks[0].description).toBe('Agent A specific');
		expect(stepTasks[1].description).toBe('Shared fallback');
	});

	test('three-agent step creates three tasks', async () => {
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: `WF-3agent-${Date.now()}`,
			steps: [
				{ id: STEP_START, name: 'Start', agentId: AGENT_A },
				{
					id: STEP_MULTI,
					name: 'Triple Parallel',
					agents: [{ agentId: AGENT_A }, { agentId: AGENT_B }, { agentId: AGENT_C }],
				},
			],
			transitions: [{ from: STEP_START, to: STEP_MULTI, condition: { type: 'always' }, order: 0 }],
			startStepId: STEP_START,
		});
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Run',
			currentStepId: STEP_START,
		});
		const executor = new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			runRepo,
			WORKSPACE,
			makeOkRunner()
		);

		const { tasks } = await executor.advance();

		expect(tasks).toHaveLength(3);
		for (const task of tasks) {
			expect(task.workflowStepId).toBe(STEP_MULTI);
			expect(task.workflowRunId).toBe(run.id);
		}
	});

	// -------------------------------------------------------------------------
	// Subtask 8: Backward compatibility — single agentId still works
	// -------------------------------------------------------------------------

	test('single agentId shorthand creates exactly one task (backward compat)', async () => {
		const STEP_SINGLE = 'step-single';
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: `WF-compat-${Date.now()}`,
			steps: [
				{ id: STEP_START, name: 'Start', agentId: AGENT_A },
				{ id: STEP_SINGLE, name: 'Single Agent', agentId: AGENT_B },
			],
			transitions: [{ from: STEP_START, to: STEP_SINGLE, condition: { type: 'always' }, order: 0 }],
			startStepId: STEP_START,
		});
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Run',
			currentStepId: STEP_START,
		});
		const executor = new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			runRepo,
			WORKSPACE,
			makeOkRunner()
		);

		const { tasks } = await executor.advance();

		expect(tasks).toHaveLength(1);
		expect(tasks[0].customAgentId).toBe(AGENT_B);
	});

	test('agents[] wins over agentId when both are present on a step', async () => {
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: `WF-agents-wins-${Date.now()}`,
			steps: [
				{ id: STEP_START, name: 'Start', agentId: AGENT_A },
				{
					id: STEP_MULTI,
					name: 'Both Present',
					agentId: AGENT_A, // should be ignored
					agents: [{ agentId: AGENT_B }, { agentId: AGENT_C }], // wins
				},
			],
			transitions: [{ from: STEP_START, to: STEP_MULTI, condition: { type: 'always' }, order: 0 }],
			startStepId: STEP_START,
		});
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Run',
			currentStepId: STEP_START,
		});
		const executor = new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			runRepo,
			WORKSPACE,
			makeOkRunner()
		);

		const { tasks } = await executor.advance();

		expect(tasks).toHaveLength(2);
		const agentIds = tasks.map((t) => t.customAgentId).sort();
		expect(agentIds).toEqual([AGENT_B, AGENT_C].sort());
	});

	test('TaskTypeResolver is called once per agent entry', async () => {
		const resolverCalls: string[] = [];
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: `WF-resolver-${Date.now()}`,
			steps: [
				{ id: STEP_START, name: 'Start', agentId: AGENT_A },
				{
					id: STEP_MULTI,
					name: 'Parallel',
					agents: [{ agentId: AGENT_A }, { agentId: AGENT_B }],
				},
			],
			transitions: [{ from: STEP_START, to: STEP_MULTI, condition: { type: 'always' }, order: 0 }],
			startStepId: STEP_START,
		});
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Run',
			currentStepId: STEP_START,
		});
		const executor = new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			runRepo,
			WORKSPACE,
			makeOkRunner(),
			(_step, agentEntry) => {
				resolverCalls.push(agentEntry.agentId);
				return { taskType: 'coding', customAgentId: agentEntry.agentId };
			}
		);

		await executor.advance();

		expect(resolverCalls).toHaveLength(2);
		expect(resolverCalls.sort()).toEqual([AGENT_A, AGENT_B].sort());
	});
});

// ===========================================================================
// SpaceRuntime — startWorkflowRun() with multi-agent start step
// ===========================================================================

describe('SpaceRuntime — startWorkflowRun() multi-agent start step', () => {
	let db: BunDatabase;
	let dir: string;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let runtime: SpaceRuntime;

	const SPACE_ID = 'space-rt-ma';
	const WORKSPACE = '/tmp/rt-ma-ws';
	const AGENT_CODER = 'agent-rt-coder';
	const AGENT_PLANNER = 'agent-rt-planner';
	const AGENT_CUSTOM = 'agent-rt-custom';
	const STEP_A = 'step-rt-a';
	const STEP_B = 'step-rt-b';

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID, WORKSPACE);
		seedAgent(db, AGENT_CODER, SPACE_ID, 'Coder', 'coder');
		seedAgent(db, AGENT_PLANNER, SPACE_ID, 'Planner', 'planner');
		seedAgent(db, AGENT_CUSTOM, SPACE_ID, 'Custom', 'my-custom-role');

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
	// Subtask 3: startWorkflowRun() with multi-agent start step
	// -------------------------------------------------------------------------

	test('creates one task per agent for a multi-agent start step', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Multi Start ${Date.now()}`,
			steps: [
				{
					id: STEP_A,
					name: 'Parallel Start',
					agents: [
						{ agentId: AGENT_CODER, instructions: 'Write code' },
						{ agentId: AGENT_PLANNER, instructions: 'Plan it' },
					],
				},
			],
			transitions: [],
			startStepId: STEP_A,
			rules: [],
			tags: [],
		});

		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Multi Start Run');

		expect(tasks).toHaveLength(2);
		for (const task of tasks) {
			expect(task.workflowRunId).toBe(run.id);
			expect(task.workflowStepId).toBe(STEP_A);
			expect(task.status).toBe('pending');
		}
	});

	test('per-agent instructions set task descriptions on multi-agent start step', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Multi Start Instructions ${Date.now()}`,
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

		const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

		const descriptions = tasks.map((t) => t.description).sort();
		expect(descriptions).toEqual(['Coder task', 'Planner task'].sort());
	});

	test('per-agent taskType is resolved for multi-agent start step', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Multi Start TaskType ${Date.now()}`,
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

	// -------------------------------------------------------------------------
	// Subtask 4: Step does NOT advance when only some tasks are complete
	// -------------------------------------------------------------------------

	test('executeTick() does NOT advance to next step when only some parallel tasks are completed', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Partial Complete ${Date.now()}`,
			steps: [
				{
					id: STEP_A,
					name: 'Parallel A',
					agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_PLANNER }],
				},
				{ id: STEP_B, name: 'Next Step', agentId: AGENT_CODER },
			],
			transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
			startStepId: STEP_A,
			rules: [],
			tags: [],
		});

		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		expect(tasks).toHaveLength(2);

		// Complete only one of the two parallel tasks
		taskRepo.updateTask(tasks[0].id, { status: 'completed' });
		// tasks[1] remains pending

		await runtime.executeTick();

		// Step B task must NOT have been created yet
		const allTasks = taskRepo.listByWorkflowRun(run.id);
		const stepBTasks = allTasks.filter((t) => t.workflowStepId === STEP_B);
		expect(stepBTasks).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Subtask 5: Step DOES advance when all tasks complete
	// -------------------------------------------------------------------------

	test('executeTick() advances to next step when ALL parallel tasks are completed', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `All Complete ${Date.now()}`,
			steps: [
				{
					id: STEP_A,
					name: 'Parallel A',
					agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_PLANNER }],
				},
				{ id: STEP_B, name: 'Next Step', agentId: AGENT_CODER },
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

	// -------------------------------------------------------------------------
	// Subtask 6: Parallel failure — one task fails, others still active → waits
	// -------------------------------------------------------------------------

	test('does NOT mark run needs_attention when one task fails but sibling is still running', async () => {
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

		// One task fails, but sibling is still in_progress
		taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Build failed' });
		taskRepo.updateTask(tasks[1].id, { status: 'in_progress' });

		await runtime.executeTick();

		// Run should still be in_progress — sibling is not terminal yet
		const updatedRun = workflowRunRepo.getRun(run.id)!;
		expect(updatedRun.status).toBe('in_progress');
	});

	// -------------------------------------------------------------------------
	// Subtask 7: Partial failure — all terminal with one failed → needs_attention
	// -------------------------------------------------------------------------

	test('marks run needs_attention when all parallel tasks are terminal and one failed', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `All Terminal Fail ${Date.now()}`,
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

		// One completes, one fails — both are terminal
		taskRepo.updateTask(tasks[0].id, { status: 'completed' });
		taskRepo.updateTask(tasks[1].id, { status: 'needs_attention', error: 'Agent crashed' });

		await runtime.executeTick();

		const updatedRun = workflowRunRepo.getRun(run.id)!;
		expect(updatedRun.status).toBe('needs_attention');
	});

	test('marks run needs_attention when two of three tasks complete but one fails', async () => {
		const AGENT_EXTRA = 'agent-rt-extra';
		seedAgent(db, AGENT_EXTRA, SPACE_ID, 'Extra', 'extra-role');

		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Three Agent Partial Fail ${Date.now()}`,
			steps: [
				{
					id: STEP_A,
					name: 'Triple Parallel',
					agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_PLANNER }, { agentId: AGENT_EXTRA }],
				},
			],
			transitions: [],
			startStepId: STEP_A,
			rules: [],
			tags: [],
		});

		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		expect(tasks).toHaveLength(3);

		taskRepo.updateTask(tasks[0].id, { status: 'completed' });
		taskRepo.updateTask(tasks[1].id, { status: 'completed' });
		taskRepo.updateTask(tasks[2].id, { status: 'needs_attention', error: 'Crash' });

		await runtime.executeTick();

		const updatedRun = workflowRunRepo.getRun(run.id)!;
		expect(updatedRun.status).toBe('needs_attention');
	});

	// -------------------------------------------------------------------------
	// Subtask 8: Single agentId backward compat in SpaceRuntime
	// -------------------------------------------------------------------------

	test('startWorkflowRun() with single agentId creates exactly one task', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Single Agent ${Date.now()}`,
			steps: [{ id: STEP_A, name: 'Start', agentId: AGENT_CODER }],
			transitions: [],
			startStepId: STEP_A,
			rules: [],
			tags: [],
		});

		const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		expect(tasks).toHaveLength(1);
		expect(tasks[0].workflowStepId).toBe(STEP_A);
	});

	// -------------------------------------------------------------------------
	// Subtask 12: Mixed workflows
	// -------------------------------------------------------------------------

	test('mixed workflow: single-agent step followed by multi-agent step', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Mixed WF ${Date.now()}`,
			steps: [
				{ id: STEP_A, name: 'Single Start', agentId: AGENT_CODER },
				{
					id: STEP_B,
					name: 'Multi Second',
					agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_PLANNER }],
				},
			],
			transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
			startStepId: STEP_A,
			rules: [],
			tags: [],
		});

		// Start: single-agent first step
		const { run, tasks: startTasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		expect(startTasks).toHaveLength(1);
		expect(startTasks[0].workflowStepId).toBe(STEP_A);

		// Complete the first task
		taskRepo.updateTask(startTasks[0].id, { status: 'completed' });
		await runtime.executeTick();

		// Multi-agent second step should have 2 new tasks
		const allTasks = taskRepo.listByWorkflowRun(run.id);
		const stepBTasks = allTasks.filter((t) => t.workflowStepId === STEP_B);
		expect(stepBTasks).toHaveLength(2);
	});

	test('mixed workflow: multi-agent step followed by single-agent step', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Mixed WF Reverse ${Date.now()}`,
			steps: [
				{
					id: STEP_A,
					name: 'Multi Start',
					agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_PLANNER }],
				},
				{ id: STEP_B, name: 'Single Second', agentId: AGENT_CODER },
			],
			transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
			startStepId: STEP_A,
			rules: [],
			tags: [],
		});

		// Start: multi-agent first step creates 2 tasks
		const { run, tasks: startTasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		expect(startTasks).toHaveLength(2);

		// Complete both parallel tasks
		taskRepo.updateTask(startTasks[0].id, { status: 'completed' });
		taskRepo.updateTask(startTasks[1].id, { status: 'completed' });
		await runtime.executeTick();

		// Single-agent second step creates exactly 1 new task
		const allTasks = taskRepo.listByWorkflowRun(run.id);
		const stepBTasks = allTasks.filter((t) => t.workflowStepId === STEP_B);
		expect(stepBTasks).toHaveLength(1);
	});
});

// ===========================================================================
// Subtask 9: resolveStepAgents() utility
// ===========================================================================

describe('resolveStepAgents()', () => {
	function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
		return { id: 'step-1', name: 'Test Step', ...overrides };
	}

	test('returns single-element array when only agentId is set', () => {
		const step = makeStep({ agentId: 'agent-a', instructions: 'do the thing' });
		const result = resolveStepAgents(step);
		expect(result).toEqual([{ agentId: 'agent-a', instructions: 'do the thing' }]);
	});

	test('returns agents array when agents is set and non-empty', () => {
		const step = makeStep({
			agents: [{ agentId: 'agent-a', instructions: 'code' }, { agentId: 'agent-b' }],
		});
		const result = resolveStepAgents(step);
		expect(result).toHaveLength(2);
		expect(result[0].agentId).toBe('agent-a');
		expect(result[1].agentId).toBe('agent-b');
	});

	test('agents takes precedence over agentId when both are set', () => {
		const step = makeStep({
			agentId: 'agent-a', // ignored
			agents: [{ agentId: 'agent-b' }], // wins
		});
		const result = resolveStepAgents(step);
		expect(result).toHaveLength(1);
		expect(result[0].agentId).toBe('agent-b');
	});

	test('throws when neither agentId nor agents is provided', () => {
		const step = makeStep();
		expect(() => resolveStepAgents(step)).toThrow(
			'WorkflowStep "Test Step" (id: step-1) has neither agentId nor agents defined'
		);
	});

	test('throws when agents is an empty array and agentId is absent', () => {
		const step = makeStep({ agents: [] });
		expect(() => resolveStepAgents(step)).toThrow();
	});

	test('single-element agents array works correctly', () => {
		const step = makeStep({ agents: [{ agentId: 'agent-a', instructions: 'custom' }] });
		expect(resolveStepAgents(step)).toEqual([{ agentId: 'agent-a', instructions: 'custom' }]);
	});

	test('agentId with no instructions produces entry with undefined instructions', () => {
		const step = makeStep({ agentId: 'agent-a' });
		const result = resolveStepAgents(step);
		expect(result[0].instructions).toBeUndefined();
	});
});

// ===========================================================================
// Subtask 10: resolveStepChannels() utility — all topology patterns
// ===========================================================================

describe('resolveStepChannels()', () => {
	const agentCoder = makeSpaceAgent('agent-coder-id', 'coder');
	const agentReviewer = makeSpaceAgent('agent-reviewer-id', 'reviewer');
	const agentSecurity = makeSpaceAgent('agent-security-id', 'security');
	const allAgents: SpaceAgent[] = [agentCoder, agentReviewer, agentSecurity];

	function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
		return { id: 'step-1', name: 'Test Step', ...overrides };
	}

	test('returns empty array when no channels defined', () => {
		const step = makeStep({ agentId: 'agent-coder-id' });
		expect(resolveStepChannels(step, allAgents)).toEqual([]);
	});

	test('returns empty array when channels is an empty array', () => {
		const step = makeStep({ agentId: 'agent-coder-id', channels: [] });
		expect(resolveStepChannels(step, allAgents)).toEqual([]);
	});

	// A → B one-way
	test('A→B one-way: resolves to single directed channel', () => {
		const step = makeStep({
			agents: [{ agentId: 'agent-coder-id' }, { agentId: 'agent-reviewer-id' }],
			channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
		});
		const result = resolveStepChannels(step, allAgents);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			fromRole: 'coder',
			toRole: 'reviewer',
			fromAgentId: 'agent-coder-id',
			toAgentId: 'agent-reviewer-id',
			direction: 'one-way',
			isHubSpoke: false,
		});
	});

	// A ↔ B bidirectional point-to-point
	test('A↔B bidirectional point-to-point: resolves to two directed channels (A→B and B→A)', () => {
		const step = makeStep({
			agents: [{ agentId: 'agent-coder-id' }, { agentId: 'agent-reviewer-id' }],
			channels: [{ from: 'coder', to: 'reviewer', direction: 'bidirectional' }],
		});
		const result = resolveStepChannels(step, allAgents);
		expect(result).toHaveLength(2);

		const forward = result.find((r) => r.fromRole === 'coder' && r.toRole === 'reviewer');
		const reverse = result.find((r) => r.fromRole === 'reviewer' && r.toRole === 'coder');

		expect(forward).toBeDefined();
		expect(forward!.isHubSpoke).toBe(false);
		expect(forward!.direction).toBe('one-way');

		expect(reverse).toBeDefined();
		expect(reverse!.isHubSpoke).toBe(false);
		expect(reverse!.direction).toBe('one-way');
	});

	// A → [B, C, D] fan-out one-way
	test('A→[B,C,D] fan-out one-way: resolves to three directed channels, no reverse', () => {
		const step = makeStep({
			agents: [
				{ agentId: 'agent-coder-id' },
				{ agentId: 'agent-reviewer-id' },
				{ agentId: 'agent-security-id' },
			],
			channels: [{ from: 'coder', to: ['reviewer', 'security'], direction: 'one-way' }],
		});
		const result = resolveStepChannels(step, allAgents);
		expect(result).toHaveLength(2);

		// All originate from coder
		expect(result.every((r) => r.fromRole === 'coder')).toBe(true);
		// No reverse channels
		expect(result.some((r) => r.toRole === 'coder')).toBe(false);
		// isHubSpoke false for one-way fan-out
		expect(result.every((r) => r.isHubSpoke === false)).toBe(true);
	});

	// A ↔ [B, C, D] fan-out bidirectional (hub-spoke)
	test('A↔[B,C,D] hub-spoke: resolves to A→B, A→C, A→D, B→A, C→A, D→A; B cannot send to C', () => {
		const step = makeStep({
			agents: [
				{ agentId: 'agent-coder-id' },
				{ agentId: 'agent-reviewer-id' },
				{ agentId: 'agent-security-id' },
			],
			channels: [{ from: 'coder', to: ['reviewer', 'security'], direction: 'bidirectional' }],
		});
		const result = resolveStepChannels(step, allAgents);

		// 2 spokes × 2 directions = 4 channels
		expect(result).toHaveLength(4);

		// All marked hub-spoke
		expect(result.every((r) => r.isHubSpoke)).toBe(true);

		// Hub → each spoke
		expect(result.some((r) => r.fromRole === 'coder' && r.toRole === 'reviewer')).toBe(true);
		expect(result.some((r) => r.fromRole === 'coder' && r.toRole === 'security')).toBe(true);

		// Each spoke → hub
		expect(result.some((r) => r.fromRole === 'reviewer' && r.toRole === 'coder')).toBe(true);
		expect(result.some((r) => r.fromRole === 'security' && r.toRole === 'coder')).toBe(true);

		// No spoke-to-spoke (B cannot send to C)
		expect(result.some((r) => r.fromRole === 'reviewer' && r.toRole === 'security')).toBe(false);
		expect(result.some((r) => r.fromRole === 'security' && r.toRole === 'reviewer')).toBe(false);
	});

	// * → B wildcard from
	test('*→B wildcard from: resolves to channels from all agents to B', () => {
		const step = makeStep({
			agents: [
				{ agentId: 'agent-coder-id' },
				{ agentId: 'agent-reviewer-id' },
				{ agentId: 'agent-security-id' },
			],
			channels: [{ from: '*', to: 'reviewer', direction: 'one-way' }],
		});
		const result = resolveStepChannels(step, allAgents);

		// coder→reviewer and security→reviewer (reviewer→reviewer self-loop skipped)
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.toRole === 'reviewer')).toBe(true);
		expect(result.every((r) => r.fromRole !== 'reviewer')).toBe(true);
	});

	// A → * wildcard to
	test('A→* wildcard to: resolves to channels from A to all other agents', () => {
		const step = makeStep({
			agents: [
				{ agentId: 'agent-coder-id' },
				{ agentId: 'agent-reviewer-id' },
				{ agentId: 'agent-security-id' },
			],
			channels: [{ from: 'coder', to: '*', direction: 'one-way' }],
		});
		const result = resolveStepChannels(step, allAgents);

		// coder→reviewer and coder→security (coder→coder self-loop skipped)
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.fromRole === 'coder')).toBe(true);
		expect(result.every((r) => r.toRole !== 'coder')).toBe(true);
	});

	// Invalid role reference → skipped silently
	test('invalid role reference is skipped silently (does not throw)', () => {
		const step = makeStep({
			agents: [{ agentId: 'agent-coder-id' }],
			channels: [{ from: 'coder', to: 'nonexistent-role', direction: 'one-way' }],
		});
		const result = resolveStepChannels(step, allAgents);
		expect(result).toHaveLength(0);
	});
});

// ===========================================================================
// Subtask 11: Channel validation in persistence (SpaceWorkflowManager)
// ===========================================================================

describe('Channel validation in SpaceWorkflowManager persistence', () => {
	let db: BunDatabase;
	let dir: string;
	let repo: SpaceWorkflowRepository;

	beforeEach(() => {
		({ db, dir } = makeDb());
		// Seed space so FK constraint on space_workflows.space_id is satisfied
		seedSpace(db, 'space-1');
		repo = new SpaceWorkflowRepository(db);
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

	test('rejects channels with non-existent role references when agentLookup is provided', () => {
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) => {
				if (id === 'agent-coder-id') return { id, name: 'Coder', role: 'coder' };
				return null;
			},
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);

		expect(() =>
			mgr.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Role Ref',
				steps: [
					{
						name: 'Step',
						agents: [{ agentId: 'agent-coder-id' }],
						channels: [{ from: 'coder', to: 'nonexistent-role', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('accepts valid channel role references when agentLookup is provided', () => {
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) => {
				if (id === 'agent-coder-id') return { id, name: 'Coder', role: 'coder' };
				if (id === 'agent-reviewer-id') return { id, name: 'Reviewer', role: 'reviewer' };
				return null;
			},
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);

		const wf = mgr.createWorkflow({
			spaceId: 'space-1',
			name: 'Valid Channel Refs',
			steps: [
				{
					name: 'Step',
					agents: [{ agentId: 'agent-coder-id' }, { agentId: 'agent-reviewer-id' }],
					channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
				},
			],
		});

		expect(wf.steps[0].channels).toHaveLength(1);
		expect(wf.steps[0].channels![0]).toMatchObject({ from: 'coder', to: 'reviewer' });
	});

	test('rejects channels on single-agent steps (channels require agents[])', () => {
		const mgr = new SpaceWorkflowManager(repo);

		expect(() =>
			mgr.createWorkflow({
				spaceId: 'space-1',
				name: 'Single Agent With Channels',
				steps: [
					{
						name: 'Step',
						agentId: 'agent-coder-id',
						channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('rejects channels with wildcard * from unknown role reference in to field', () => {
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) => {
				if (id === 'agent-coder-id') return { id, name: 'Coder', role: 'coder' };
				return null;
			},
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);

		expect(() =>
			mgr.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad To Role',
				steps: [
					{
						name: 'Step',
						agents: [{ agentId: 'agent-coder-id' }],
						channels: [{ from: 'nonexistent', to: 'coder', direction: 'one-way' }],
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('accepts * wildcard in channel roles even with agentLookup', () => {
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) => {
				if (id === 'agent-coder-id') return { id, name: 'Coder', role: 'coder' };
				return null;
			},
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);

		const wf = mgr.createWorkflow({
			spaceId: 'space-1',
			name: 'Wildcard OK',
			steps: [
				{
					name: 'Step',
					agents: [{ agentId: 'agent-coder-id' }],
					channels: [{ from: '*', to: 'coder', direction: 'one-way' }],
				},
			],
		});
		expect(wf.steps[0].channels).toHaveLength(1);
	});
});

// ===========================================================================
// Subtask 12: Mixed workflows (single-agent + multi-agent + channels)
// ===========================================================================

describe('Mixed workflows — single-agent, multi-agent, and channels', () => {
	let db: BunDatabase;
	let dir: string;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let runtime: SpaceRuntime;

	const SPACE_ID = 'space-mixed';
	const WORKSPACE = '/tmp/ws-mixed';
	const AGENT_CODER = 'agent-mixed-coder';
	const AGENT_PLANNER = 'agent-mixed-planner';
	const AGENT_REVIEWER = 'agent-mixed-reviewer';
	const STEP_A = 'step-mx-a';
	const STEP_B = 'step-mx-b';
	const STEP_C = 'step-mx-c';

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID, WORKSPACE);
		seedAgent(db, AGENT_CODER, SPACE_ID, 'Coder', 'coder');
		seedAgent(db, AGENT_PLANNER, SPACE_ID, 'Planner', 'planner');
		seedAgent(db, AGENT_REVIEWER, SPACE_ID, 'Reviewer', 'reviewer');

		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);
		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);
		const spaceManager = new SpaceManager(db);

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

	test('three-step workflow: single → multi → single', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Single-Multi-Single ${Date.now()}`,
			steps: [
				{ id: STEP_A, name: 'Plan (single)', agentId: AGENT_PLANNER },
				{
					id: STEP_B,
					name: 'Implement (multi)',
					agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_REVIEWER }],
				},
				{ id: STEP_C, name: 'Finalize (single)', agentId: AGENT_PLANNER },
			],
			transitions: [
				{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 },
				{ from: STEP_B, to: STEP_C, condition: { type: 'always' }, order: 0 },
			],
			startStepId: STEP_A,
			rules: [],
			tags: [],
		});

		// Step A: single-agent
		const { run, tasks: tasksA } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		expect(tasksA).toHaveLength(1);
		expect(tasksA[0].workflowStepId).toBe(STEP_A);

		// Complete step A
		taskRepo.updateTask(tasksA[0].id, { status: 'completed' });
		await runtime.executeTick();

		// Step B: multi-agent
		const allAfterA = taskRepo.listByWorkflowRun(run.id);
		const tasksB = allAfterA.filter((t) => t.workflowStepId === STEP_B);
		expect(tasksB).toHaveLength(2);

		// Complete both step B tasks
		taskRepo.updateTask(tasksB[0].id, { status: 'completed' });
		taskRepo.updateTask(tasksB[1].id, { status: 'completed' });
		await runtime.executeTick();

		// Step C: single-agent
		const allAfterB = taskRepo.listByWorkflowRun(run.id);
		const tasksC = allAfterB.filter((t) => t.workflowStepId === STEP_C);
		expect(tasksC).toHaveLength(1);

		// Complete final step
		taskRepo.updateTask(tasksC[0].id, { status: 'completed' });
		await runtime.executeTick();

		// Run should be completed
		const finalRun = workflowRunRepo.getRun(run.id)!;
		expect(finalRun.status).toBe('completed');
	});

	test('multi-agent step with channels stored in run config after advance', async () => {
		// Seed agents with roles matching channel references
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Channel Step ${Date.now()}`,
			steps: [
				{
					id: STEP_A,
					name: 'Parallel With Channels',
					agents: [{ agentId: AGENT_CODER }, { agentId: AGENT_REVIEWER }],
					channels: [
						{ from: 'coder', to: 'reviewer', direction: 'one-way', label: 'review-request' },
					],
				},
			],
			transitions: [],
			startStepId: STEP_A,
			rules: [],
			tags: [],
		});

		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

		// Two tasks created for multi-agent start step
		expect(tasks).toHaveLength(2);

		// Resolved channels stored in run config
		const updatedRun = workflowRunRepo.getRun(run.id)!;
		const config = (updatedRun.config ?? {}) as Record<string, unknown>;
		const resolvedChannels = config._resolvedChannels as Array<Record<string, unknown>> | undefined;

		expect(resolvedChannels).toBeDefined();
		expect(resolvedChannels).toHaveLength(1);
		expect(resolvedChannels![0]).toMatchObject({
			fromRole: 'coder',
			toRole: 'reviewer',
			direction: 'one-way',
			label: 'review-request',
		});
	});
});
