/**
 * Workflow Iteration Loop Integration Tests
 *
 * End-to-end test for cyclic workflows with task_result conditions:
 * - Full cycle executes correctly: fail -> loop -> pass -> complete
 * - iterationCount is 1 (one logical cycle = one loop-back from Verify to Plan)
 * - All 6 tasks are under the same workflow run with correct step IDs
 * - Run status is 'completed' at the end
 *
 * Uses a real in-memory SQLite database (not mocked objects) to verify
 * the full DB round-trip.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import {
	WorkflowExecutor,
	WorkflowTransitionError,
} from '../../../src/lib/space/runtime/workflow-executor.ts';
import type { SpaceWorkflow, SpaceWorkflowRun, SpaceTask } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-workflow-iteration-loop',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpace(db: BunDatabase, spaceId = 'space-1', workspacePath = '/tmp/ws-1'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt,
     config, created_at, updated_at, role)
     VALUES (?, ?, ?, '', null, '[]', '', null, ?, ?, 'coder')`
	).run(agentId, spaceId, name, Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Workflow Iteration Loop', () => {
	let db: BunDatabase;
	let dir: string;
	let workflowRepo: SpaceWorkflowRepository;
	let runRepo: SpaceWorkflowRunRepository;
	let taskManager: SpaceTaskManager;

	const SPACE_ID = 'space-cyclic-1';
	const WORKSPACE = '/tmp/ws-cyclic';

	// Step IDs
	const STEP_PLAN = 'step-plan';
	const STEP_CODE = 'step-code';
	const STEP_VERIFY = 'step-verify';
	const STEP_DONE = 'step-done';

	// Agent IDs
	const AGENT_PLANNER = 'agent-planner';
	const AGENT_CODER = 'agent-coder';

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID, WORKSPACE);
		seedAgent(db, AGENT_PLANNER, SPACE_ID, 'Planner');
		seedAgent(db, AGENT_CODER, SPACE_ID, 'Coder');

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
	// Helpers
	// -------------------------------------------------------------------------

	function makeExecutor(workflow: SpaceWorkflow, run: SpaceWorkflowRun): WorkflowExecutor {
		return new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			runRepo,
			WORKSPACE,
			async () => ({ exitCode: 0 }) // always succeeds for 'condition' type
		);
	}

	/**
	 * Builds a 4-step cyclic workflow: Plan -> Code -> Verify -> Done
	 * - Plan -> Code: human condition (requires approval)
	 * - Code -> Verify: always condition
	 * - Verify -> Plan: task_result condition, expression 'failed', order 0, isCyclic: true
	 * - Verify -> Done: task_result condition, expression 'passed', order 1
	 */
	function buildCyclicWorkflow(): SpaceWorkflow {
		const steps = [
			{ id: STEP_PLAN, name: 'Plan', agentId: AGENT_PLANNER },
			{ id: STEP_CODE, name: 'Code', agentId: AGENT_CODER },
			{ id: STEP_VERIFY, name: 'Verify', agentId: AGENT_CODER },
			{ id: STEP_DONE, name: 'Done', agentId: AGENT_CODER },
		];

		const transitions = [
			// Plan -> Code: human condition (requires approval each time)
			{ from: STEP_PLAN, to: STEP_CODE, condition: { type: 'human' as const }, order: 0 },
			// Code -> Verify: always
			{ from: STEP_CODE, to: STEP_VERIFY, condition: { type: 'always' as const }, order: 0 },
			// Verify -> Plan: task_result 'failed', isCyclic (loops back)
			{
				from: STEP_VERIFY,
				to: STEP_PLAN,
				condition: { type: 'task_result' as const, expression: 'failed' },
				order: 0,
				isCyclic: true,
			},
			// Verify -> Done: task_result 'passed' (terminal on pass)
			{
				from: STEP_VERIFY,
				to: STEP_DONE,
				condition: { type: 'task_result' as const, expression: 'passed' },
				order: 1,
			},
		];

		return workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: `Cyclic WF ${Date.now()}`,
			steps,
			transitions,
			startStepId: STEP_PLAN,
			maxIterations: 3,
		});
	}

	/**
	 * Simulates a human approval on the run config so the human-gate transition can pass.
	 */
	function setHumanApproval(runId: string): void {
		runRepo.updateRun(runId, { config: { humanApproved: true } });
	}

	// -------------------------------------------------------------------------
	// End-to-end cyclic workflow test
	// -------------------------------------------------------------------------

	test('end-to-end cyclic workflow: fail -> loop -> pass -> complete', async () => {
		const workflow = buildCyclicWorkflow();

		// Create run
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Cyclic Iteration Test',
			currentStepId: workflow.startStepId,
			maxIterations: 3,
		});

		// Set run to in_progress
		const activeRun = runRepo.updateStatus(run.id, 'in_progress')!;

		// Create initial Plan task
		const planTask1 = await taskManager.createTask({
			title: 'Plan',
			description: 'Plan step task',
			workflowRunId: run.id,
			workflowStepId: STEP_PLAN,
			status: 'pending',
		});

		// Complete Plan(1) and set human approval
		await taskManager.setTaskStatus(planTask1.id, 'in_progress');
		await taskManager.setTaskStatus(planTask1.id, 'completed', { result: 'Plan 1 done' });
		setHumanApproval(run.id);

		// Create executor and advance: Plan -> Code
		let executor = makeExecutor(workflow, activeRun);
		let result = await executor.advance();
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].workflowStepId).toBe(STEP_CODE);
		expect(result.tasks[0].title).toBe('Code');

		// Complete Code(1) and advance: Code -> Verify
		const codeTask1 = result.tasks[0];
		await taskManager.setTaskStatus(codeTask1.id, 'in_progress');
		await taskManager.setTaskStatus(codeTask1.id, 'completed', { result: 'Code 1 done' });
		result = await executor.advance();
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].workflowStepId).toBe(STEP_VERIFY);

		// Complete Verify(1) with 'failed' and advance: Verify -> Plan (cyclic)
		const verifyTask1 = result.tasks[0];
		await taskManager.setTaskStatus(verifyTask1.id, 'in_progress');
		await taskManager.setTaskStatus(verifyTask1.id, 'completed', {
			result: 'failed: tests broken',
		});
		result = await executor.advance();
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].workflowStepId).toBe(STEP_PLAN);
		expect(result.tasks[0].title).toBe('Plan');

		let runState = runRepo.getRun(run.id)!;
		expect(runState.iterationCount).toBe(1);
		expect(runState.currentStepId).toBe(STEP_PLAN);
		expect(runState.status).toBe('in_progress');

		// Complete Plan(2) and set human approval
		const planTask2 = result.tasks[0];
		await taskManager.setTaskStatus(planTask2.id, 'in_progress');
		await taskManager.setTaskStatus(planTask2.id, 'completed', { result: 'Plan 2 done' });
		setHumanApproval(run.id);

		// Advance: Plan -> Code
		result = await executor.advance();
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].workflowStepId).toBe(STEP_CODE);

		// Complete Code(2) and advance: Code -> Verify
		const codeTask2 = result.tasks[0];
		await taskManager.setTaskStatus(codeTask2.id, 'in_progress');
		await taskManager.setTaskStatus(codeTask2.id, 'completed', { result: 'Code 2 done' });
		result = await executor.advance();
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].workflowStepId).toBe(STEP_VERIFY);

		// Complete Verify(2) with 'passed' and advance: Verify -> Done
		const verifyTask2 = result.tasks[0];
		await taskManager.setTaskStatus(verifyTask2.id, 'in_progress');
		await taskManager.setTaskStatus(verifyTask2.id, 'completed', { result: 'passed' });
		result = await executor.advance();
		// First advance: creates Done task (transition to terminal step still creates a task)
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].workflowStepId).toBe(STEP_DONE);

		// Second advance: Done is terminal, marks run as completed
		result = await executor.advance();
		expect(result.tasks).toHaveLength(0); // Done is terminal

		runState = runRepo.getRun(run.id)!;
		expect(runState.status).toBe('completed');
		expect(runState.currentStepId).toBe(STEP_DONE);
		expect(runState.iterationCount).toBe(1);

		// Verify all 7 tasks are under the same run (6 from 2 cycles + 1 terminal Done task)
		const allTasks = await taskManager.listTasksByWorkflowRun(run.id);
		expect(allTasks).toHaveLength(7);

		for (const task of allTasks) {
			expect(task.workflowRunId).toBe(run.id);
		}

		// Verify Verify task results
		const verifyTasks = allTasks.filter((t) => t.workflowStepId === STEP_VERIFY);
		expect(verifyTasks).toHaveLength(2);
		const sorted = verifyTasks.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
		expect(sorted[0].result).toBe('failed: tests broken');
		expect(sorted[1].result).toBe('passed');
	});

	test('iterationCount is 1 after single loop-back', async () => {
		const workflow = buildCyclicWorkflow();

		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Iteration Count Test',
			currentStepId: workflow.startStepId,
			maxIterations: 3,
		});

		const activeRun = runRepo.updateStatus(run.id, 'in_progress')!;

		// Plan 1 -> Code -> Verify(1) -> loop back to Plan(2) -> Code(2) -> Verify(2) -> Done
		const p1 = await taskManager.createTask({
			title: 'Plan',
			description: 'Plan task 1',
			workflowRunId: run.id,
			workflowStepId: STEP_PLAN,
			status: 'pending',
		});
		await taskManager.setTaskStatus(p1.id, 'in_progress');
		await taskManager.setTaskStatus(p1.id, 'completed', { result: 'done' });
		setHumanApproval(run.id);
		let executor = makeExecutor(workflow, activeRun);
		await executor.advance(); // -> Code

		let r = await executor.advance(); // -> Verify
		const v1 = r.tasks[0];
		await taskManager.setTaskStatus(v1.id, 'in_progress');
		await taskManager.setTaskStatus(v1.id, 'completed', { result: 'failed: broken' });
		r = await executor.advance(); // -> Plan (cyclic)

		let runState = runRepo.getRun(run.id)!;
		expect(runState.iterationCount).toBe(1);

		const p2 = r.tasks[0];
		await taskManager.setTaskStatus(p2.id, 'in_progress');
		await taskManager.setTaskStatus(p2.id, 'completed', { result: 'done' });
		setHumanApproval(run.id);
		r = await executor.advance(); // -> Code

		const c2 = r.tasks[0];
		await taskManager.setTaskStatus(c2.id, 'in_progress');
		await taskManager.setTaskStatus(c2.id, 'completed', { result: 'done' });
		r = await executor.advance(); // -> Verify

		const v2 = r.tasks[0];
		await taskManager.setTaskStatus(v2.id, 'in_progress');
		await taskManager.setTaskStatus(v2.id, 'completed', { result: 'passed' });
		r = await executor.advance(); // -> Done (creates task)
		r = await executor.advance(); // -> Done is terminal, marks completed

		runState = runRepo.getRun(run.id)!;
		expect(runState.status).toBe('completed');
		expect(runState.iterationCount).toBe(1);
	});

	test('human approval is required for each Plan -> Code traversal', async () => {
		const workflow = buildCyclicWorkflow();

		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Human Approval Test',
			currentStepId: workflow.startStepId,
			maxIterations: 3,
		});

		const activeRun = runRepo.updateStatus(run.id, 'in_progress')!;

		const p1 = await taskManager.createTask({
			title: 'Plan',
			description: 'Plan task 1',
			workflowRunId: run.id,
			workflowStepId: STEP_PLAN,
			status: 'pending',
		});
		await taskManager.setTaskStatus(p1.id, 'in_progress');
		await taskManager.setTaskStatus(p1.id, 'completed', { result: 'done' });
		setHumanApproval(run.id);
		let executor = makeExecutor(workflow, activeRun);
		await executor.advance(); // -> Code

		let r = await executor.advance(); // -> Verify
		const v1 = r.tasks[0];
		await taskManager.setTaskStatus(v1.id, 'in_progress');
		await taskManager.setTaskStatus(v1.id, 'completed', { result: 'failed: broken' });
		r = await executor.advance(); // -> Plan (cyclic)

		const p2 = r.tasks[0];
		await taskManager.setTaskStatus(p2.id, 'in_progress');
		await taskManager.setTaskStatus(p2.id, 'completed', { result: 'done' });
		// DON'T set human approval - should fail

		// Create fresh executor
		let runState = runRepo.getRun(run.id)!;
		executor = makeExecutor(workflow, runState);

		// Should fail because human approval is not set
		await expect(executor.advance()).rejects.toThrow(/human/i);

		// Now set approval and reset status to retry
		setHumanApproval(run.id);
		runRepo.updateStatus(run.id, 'in_progress');
		runState = runRepo.getRun(run.id)!;
		executor = makeExecutor(workflow, runState);
		r = await executor.advance();
		expect(r.tasks[0].workflowStepId).toBe(STEP_CODE);
	});

	test('maxIterations is respected', async () => {
		const workflow = buildCyclicWorkflow();

		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Max Iter Test',
			currentStepId: workflow.startStepId,
			maxIterations: 2, // First loop-back succeeds (count=1), second throws (count=2 >= 2)
		});

		const activeRun = runRepo.updateStatus(run.id, 'in_progress')!;

		const p1 = await taskManager.createTask({
			title: 'Plan',
			description: 'Plan task 1',
			workflowRunId: run.id,
			workflowStepId: STEP_PLAN,
			status: 'pending',
		});
		await taskManager.setTaskStatus(p1.id, 'in_progress');
		await taskManager.setTaskStatus(p1.id, 'completed', { result: 'done' });
		setHumanApproval(run.id);
		let executor = makeExecutor(workflow, activeRun);
		await executor.advance(); // -> Code

		let r = await executor.advance(); // -> Verify
		const v1 = r.tasks[0];
		await taskManager.setTaskStatus(v1.id, 'in_progress');
		await taskManager.setTaskStatus(v1.id, 'completed', { result: 'failed: broken' });
		// First cyclic: iterationCount becomes 1, succeeds (1 < 2)
		r = await executor.advance(); // -> Plan (cyclic), iterationCount = 1

		let runState = runRepo.getRun(run.id)!;
		expect(runState.iterationCount).toBe(1);
		expect(runState.status).toBe('in_progress');

		const p2 = r.tasks[0];
		await taskManager.setTaskStatus(p2.id, 'in_progress');
		await taskManager.setTaskStatus(p2.id, 'completed', { result: 'done' });
		setHumanApproval(run.id);
		executor = makeExecutor(workflow, runState);
		r = await executor.advance(); // -> Code

		const c2 = r.tasks[0];
		await taskManager.setTaskStatus(c2.id, 'in_progress');
		await taskManager.setTaskStatus(c2.id, 'completed', { result: 'done' });
		r = await executor.advance(); // -> Verify

		const v2 = r.tasks[0];
		await taskManager.setTaskStatus(v2.id, 'in_progress');
		await taskManager.setTaskStatus(v2.id, 'completed', { result: 'failed: broken' });
		// Second cyclic: iterationCount would become 2, which >= maxIterations=2, throws
		runState = runRepo.getRun(run.id)!;
		executor = makeExecutor(workflow, runState);

		// Should throw because iteration cap is reached
		let thrownError: Error | undefined;
		try {
			await executor.advance();
		} catch (e) {
			thrownError = e as Error;
		}
		expect(thrownError).toBeInstanceOf(WorkflowTransitionError);
		expect(thrownError!.message).toContain('Iteration cap reached');

		runState = runRepo.getRun(run.id)!;
		expect(runState.status).toBe('needs_attention');
		expect(runState.iterationCount).toBe(2);
	});
});
