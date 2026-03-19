/**
 * WorkflowExecutor Unit Tests
 *
 * Covers:
 * - Graph navigation (getCurrentStep, getOutgoingTransitions, isComplete)
 * - Multi-step linear progression (A → B → terminal)
 * - Terminal step detection (no outgoing transitions → run completes)
 * - Condition types: always, human, condition
 * - Timeout enforcement on condition-type transitions
 * - Retry logic: re-evaluate condition only (not re-run agent)
 * - Completion detection (isComplete after last step)
 * - needs_attention guard (advance() blocked after condition failure)
 * - Cycle support (A → B → A loops)
 * - WorkflowGateError properties
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
	WorkflowGateError,
} from '../../../src/lib/space/runtime/workflow-executor.ts';
import type {
	CommandRunner,
	ConditionContext,
} from '../../../src/lib/space/runtime/workflow-executor.ts';
import type { SpaceWorkflow, SpaceWorkflowRun, WorkflowCondition } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-workflow-executor',
		`t-${Date.now()}-${Math.random()}`
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
     config, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, name, Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Mock command runners
// ---------------------------------------------------------------------------

function makeOkRunner(): CommandRunner {
	return async () => ({ exitCode: 0 });
}

function makeFailRunner(exitCode = 1): CommandRunner {
	return async () => ({ exitCode });
}

function makeTimeoutRunner(): CommandRunner {
	return async () => ({ exitCode: null, timedOut: true });
}

/** Succeeds after `failTimes` failures */
function makeRetryRunner(failTimes: number): CommandRunner {
	let calls = 0;
	return async () => {
		calls++;
		if (calls <= failTimes) return { exitCode: 1 };
		return { exitCode: 0 };
	};
}

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

describe('WorkflowExecutor', () => {
	let db: BunDatabase;
	let dir: string;
	let workflowRepo: SpaceWorkflowRepository;
	let runRepo: SpaceWorkflowRunRepository;
	let taskManager: SpaceTaskManager;

	const SPACE_ID = 'space-1';
	const WORKSPACE = '/tmp/ws-1';
	const AGENT_A = 'agent-a';
	const AGENT_B = 'agent-b';
	const AGENT_C = 'agent-c';

	// Step ID constants used to wire up transitions
	const STEP_A = 'step-a';
	const STEP_B = 'step-b';
	const STEP_C = 'step-c';

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID, WORKSPACE);
		seedAgent(db, AGENT_A, SPACE_ID, 'Agent A');
		seedAgent(db, AGENT_B, SPACE_ID, 'Agent B');
		seedAgent(db, AGENT_C, SPACE_ID, 'Agent C');

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

	function makeExecutor(
		workflow: SpaceWorkflow,
		run: SpaceWorkflowRun,
		runner?: CommandRunner
	): WorkflowExecutor {
		return new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			runRepo,
			WORKSPACE,
			runner ?? makeOkRunner()
		);
	}

	/**
	 * Creates a linear A→B→C workflow and a run starting at the first step.
	 * Steps that have no transition leaving them are terminal.
	 * `stepsSpec` maps step ID to { name, agentId, condition? for incoming transition }.
	 */
	function createLinearWorkflow(
		stepsSpec: Array<{
			id: string;
			name: string;
			agentId: string;
			instructions?: string;
			// condition on the transition FROM the previous step TO this step
			incomingCondition?: WorkflowCondition;
		}>
	): { workflow: SpaceWorkflow; run: SpaceWorkflowRun } {
		const steps = stepsSpec.map((s) => ({
			id: s.id,
			name: s.name,
			agentId: s.agentId,
			instructions: s.instructions,
		}));

		const transitions = stepsSpec.slice(1).map((s, i) => ({
			from: stepsSpec[i].id,
			to: s.id,
			condition: s.incomingCondition,
			order: 0,
		}));

		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: `WF-${Date.now()}`,
			steps,
			transitions,
			startStepId: stepsSpec[0].id,
		});

		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title: 'Test Run',
			currentStepId: workflow.startStepId,
		});

		return { workflow, run };
	}

	// =========================================================================
	// Navigation
	// =========================================================================

	describe('getCurrentStep / getOutgoingTransitions / isComplete', () => {
		test('getCurrentStep returns the step at currentStepId', () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
			]);
			const executor = makeExecutor(workflow, run);
			expect(executor.getCurrentStep()?.name).toBe('Step A');
		});

		test('getCurrentStep returns null when run is completed', () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const completedRun = { ...run, status: 'completed' as const };
			const executor = makeExecutor(workflow, completedRun);
			expect(executor.getCurrentStep()).toBeNull();
		});

		test('getCurrentStep returns null when run is cancelled', () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const cancelledRun = { ...run, status: 'cancelled' as const };
			const executor = makeExecutor(workflow, cancelledRun);
			expect(executor.getCurrentStep()).toBeNull();
		});

		test('getOutgoingTransitions returns transitions from currentStepId', () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
			]);
			const executor = makeExecutor(workflow, run);
			const transitions = executor.getOutgoingTransitions();
			expect(transitions).toHaveLength(1);
			expect(transitions[0].from).toBe(STEP_A);
			expect(transitions[0].to).toBe(STEP_B);
		});

		test('getOutgoingTransitions returns empty for terminal step', () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			expect(executor.getOutgoingTransitions()).toHaveLength(0);
		});

		test('isComplete returns false at start of workflow', () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
			]);
			const executor = makeExecutor(workflow, run);
			expect(executor.isComplete()).toBe(false);
		});

		test('isComplete returns true when status is completed', () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const completedRun = { ...run, status: 'completed' as const };
			expect(makeExecutor(workflow, completedRun).isComplete()).toBe(true);
		});

		test('isComplete returns true when status is cancelled', () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const cancelledRun = { ...run, status: 'cancelled' as const };
			expect(makeExecutor(workflow, cancelledRun).isComplete()).toBe(true);
		});
	});

	// =========================================================================
	// Terminal step (no outgoing transitions)
	// =========================================================================

	describe('terminal step — no outgoing transitions', () => {
		test('advance() on terminal step marks run as completed and returns terminal step', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Only Step', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);

			const result = await executor.advance();

			expect(result.step.name).toBe('Only Step');
			expect(result.tasks).toHaveLength(0);
			expect(executor.isComplete()).toBe(true);
		});

		test('advance() on terminal step sets DB status to completed', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Only Step', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);

			await executor.advance();

			expect(runRepo.getRun(run.id)?.status).toBe('completed');
		});

		test('getCurrentStep returns null after terminal step advances', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Only Step', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			await executor.advance();
			expect(executor.getCurrentStep()).toBeNull();
		});
	});

	// =========================================================================
	// Multi-step linear progression
	// =========================================================================

	describe('multi-step linear progression', () => {
		test('advance() follows A→B and creates task for B', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A, instructions: 'Do A' },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B, instructions: 'Do B' },
			]);
			const executor = makeExecutor(workflow, run);

			const result = await executor.advance();

			expect(result.step.name).toBe('Step B');
			expect(result.tasks).toHaveLength(1);
			expect(result.tasks[0].title).toBe('Step B');
			expect(result.tasks[0].description).toBe('Do B');
			expect(result.tasks[0].status).toBe('pending');
			expect(result.tasks[0].workflowRunId).toBe(run.id);
			expect(result.tasks[0].workflowStepId).toBe(result.step.id);
			expect(result.tasks[0].customAgentId).toBe(AGENT_B);
		});

		test('advance() persists new currentStepId in DB', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
			]);
			// Get the real step B ID from the workflow (DB may have overridden the template IDs)
			const stepBId = workflow.steps.find((s) => s.name === 'Step B')!.id;
			const executor = makeExecutor(workflow, run);

			await executor.advance();

			const updated = runRepo.getRun(run.id);
			expect(updated?.currentStepId).toBe(stepBId);
		});

		test('getCurrentStep reflects new step after advance()', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
			]);
			const executor = makeExecutor(workflow, run);

			expect(executor.getCurrentStep()?.name).toBe('Step A');
			await executor.advance();
			expect(executor.getCurrentStep()?.name).toBe('Step B');
		});

		test('advances through A→B→terminal in sequence', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
				{ id: STEP_C, name: 'Step C', agentId: AGENT_C },
			]);
			const executor = makeExecutor(workflow, run);

			const r1 = await executor.advance();
			expect(r1.step.name).toBe('Step B');
			expect(executor.isComplete()).toBe(false);

			const r2 = await executor.advance();
			expect(r2.step.name).toBe('Step C');
			expect(executor.isComplete()).toBe(false);

			// Step C has no outgoing transitions → terminal
			const r3 = await executor.advance();
			expect(r3.step.name).toBe('Step C');
			expect(r3.tasks).toHaveLength(0);
			expect(executor.isComplete()).toBe(true);
		});

		test('advance() throws when workflow is already complete', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Only Step', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			await executor.advance(); // → completes

			await expect(executor.advance()).rejects.toThrow('already complete');
		});

		test('created task uses empty string when step has no instructions', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B }, // no instructions
			]);
			const executor = makeExecutor(workflow, run);

			const { tasks } = await executor.advance();
			expect(tasks[0].description).toBe('');
		});
	});

	// =========================================================================
	// Condition type: always
	// =========================================================================

	describe('condition type: always', () => {
		test('always condition passes unconditionally', async () => {
			const { workflow, run } = createLinearWorkflow([
				{
					id: STEP_A,
					name: 'Step A',
					agentId: AGENT_A,
				},
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: { type: 'always' },
				},
			]);
			const executor = makeExecutor(workflow, run);
			const result = await executor.advance();
			expect(result.step.name).toBe('Step B');
		});

		test('evaluateCondition: always always passes', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = { workspacePath: WORKSPACE };
			const result = await executor.evaluateCondition({ type: 'always' }, ctx);
			expect(result.passed).toBe(true);
		});
	});

	// =========================================================================
	// Condition type: human
	// =========================================================================

	describe('condition type: human', () => {
		test('evaluateCondition: human passes when humanApproved is true', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = { workspacePath: WORKSPACE, humanApproved: true };
			const result = await executor.evaluateCondition({ type: 'human' }, ctx);
			expect(result.passed).toBe(true);
		});

		test('evaluateCondition: human fails when humanApproved is false', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = { workspacePath: WORKSPACE, humanApproved: false };
			const result = await executor.evaluateCondition({ type: 'human' }, ctx);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('human approval');
		});

		test('evaluateCondition: human fails when humanApproved is absent', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = { workspacePath: WORKSPACE };
			const result = await executor.evaluateCondition({ type: 'human' }, ctx);
			expect(result.passed).toBe(false);
		});

		test('advance() blocks on human transition and marks needs_attention', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: { type: 'human', description: 'Approve this' },
				},
			]);
			// run.config has no humanApproved
			const executor = makeExecutor(workflow, run);

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			expect(runRepo.getRun(run.id)?.status).toBe('needs_attention');
		});

		test('advance() follows human transition when run.config.humanApproved is true', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: { type: 'human' },
				},
			]);
			// Simulate human setting approval in run config
			const approvedRun = runRepo.updateRun(run.id, { config: { humanApproved: true } })!;

			const executor = makeExecutor(workflow, approvedRun);
			const result = await executor.advance();
			expect(result.step.name).toBe('Step B');
		});
	});

	// =========================================================================
	// Condition type: condition (user-supplied expression)
	// =========================================================================

	describe('condition type: condition', () => {
		test('evaluateCondition: passes when expression exits 0', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const ctx: ConditionContext = { workspacePath: WORKSPACE };
			const result = await executor.evaluateCondition(
				{ type: 'condition', expression: 'bun test' },
				ctx
			);
			expect(result.passed).toBe(true);
		});

		test('evaluateCondition: fails when expression exits non-zero', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run, makeFailRunner(1));
			const ctx: ConditionContext = { workspacePath: WORKSPACE };
			const result = await executor.evaluateCondition(
				{ type: 'condition', expression: 'bun test' },
				ctx
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('code 1');
		});

		test('evaluateCondition: fails when expression is empty', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = { workspacePath: WORKSPACE };
			const result = await executor.evaluateCondition({ type: 'condition', expression: '' }, ctx);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('non-empty expression');
		});

		test('advance() follows condition transition when expression passes', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: { type: 'condition', expression: 'bun test' },
				},
			]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.advance();
			expect(result.step.name).toBe('Step B');
		});

		test('advance() marks needs_attention when condition expression fails', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: { type: 'condition', expression: 'bun test' },
				},
			]);
			const executor = makeExecutor(workflow, run, makeFailRunner(1));

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			expect(runRepo.getRun(run.id)?.status).toBe('needs_attention');
		});

		test('no allowlist: any expression is accepted (user responsibility)', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: { type: 'condition', expression: 'rm -rf /tmp/danger' },
				},
			]);
			// The ok runner simulates exit 0 — no allowlist check should reject it
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.advance();
			expect(result.step.name).toBe('Step B');
		});
	});

	// =========================================================================
	// Timeout enforcement
	// =========================================================================

	describe('timeout enforcement', () => {
		test('condition transition fails when expression times out', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run, makeTimeoutRunner());
			const ctx: ConditionContext = { workspacePath: WORKSPACE };
			const result = await executor.evaluateCondition(
				{ type: 'condition', expression: 'bun test', timeoutMs: 5000 },
				ctx
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('timed out');
		});

		test('advance() marks needs_attention when condition transition times out', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: { type: 'condition', expression: 'bun test', timeoutMs: 100 },
				},
			]);
			const executor = makeExecutor(workflow, run, makeTimeoutRunner());

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			expect(runRepo.getRun(run.id)?.status).toBe('needs_attention');
		});
	});

	// =========================================================================
	// Retry logic
	// =========================================================================

	describe('retry logic', () => {
		test('condition passes after failing twice with maxRetries=2', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: {
						type: 'condition',
						expression: 'bun test',
						maxRetries: 2,
					},
				},
			]);
			// Fails first 2 attempts, passes on 3rd
			const executor = makeExecutor(workflow, run, makeRetryRunner(2));

			const result = await executor.advance();
			expect(result.step.name).toBe('Step B');
		});

		test('condition fails after exhausting all retries → needs_attention', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: {
						type: 'condition',
						expression: 'bun test',
						maxRetries: 1, // 2 total attempts
					},
				},
			]);
			// Fails 3 times — more than allowed
			const executor = makeExecutor(workflow, run, makeRetryRunner(3));

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			expect(runRepo.getRun(run.id)?.status).toBe('needs_attention');
		});

		test('retry re-evaluates condition only, does not re-run the agent', async () => {
			let callCount = 0;
			const runner: CommandRunner = async () => {
				callCount++;
				return { exitCode: callCount >= 3 ? 0 : 1 };
			};

			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: {
						type: 'condition',
						expression: 'bun test',
						maxRetries: 3,
					},
				},
			]);
			const executor = makeExecutor(workflow, run, runner);

			await executor.advance();

			// 3 evaluations: 2 fail + 1 pass
			expect(callCount).toBe(3);
		});

		test('no retry by default (maxRetries=0) — single attempt', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: {
						type: 'condition',
						expression: 'bun test',
						// no maxRetries → defaults to 0
					},
				},
			]);
			// Fails on first attempt only
			const executor = makeExecutor(workflow, run, makeRetryRunner(1));

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);
		});
	});

	// =========================================================================
	// needs_attention guard
	// =========================================================================

	describe('needs_attention guard', () => {
		test('advance() throws after a condition failure sets needs_attention', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: { type: 'human' },
				},
			]);
			const executor = makeExecutor(workflow, run);

			// First call: condition fails → needs_attention
			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			// Second call: must throw immediately (not re-evaluate)
			await expect(executor.advance()).rejects.toThrow('needs_attention');
		});

		test('advance() does not change status again on second call after needs_attention', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: { type: 'human' },
				},
			]);
			const executor = makeExecutor(workflow, run);

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			const statusBefore = runRepo.getRun(run.id)?.status;
			await expect(executor.advance()).rejects.toThrow('needs_attention');
			const statusAfter = runRepo.getRun(run.id)?.status;

			expect(statusBefore).toBe('needs_attention');
			expect(statusAfter).toBe('needs_attention'); // unchanged
		});
	});

	// =========================================================================
	// WorkflowGateError properties
	// =========================================================================

	describe('WorkflowGateError', () => {
		test('condition failure throws WorkflowGateError with descriptive message', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{
					id: STEP_B,
					name: 'Step B',
					agentId: AGENT_B,
					incomingCondition: { type: 'human' },
				},
			]);
			const executor = makeExecutor(workflow, run);

			let caught: WorkflowGateError | undefined;
			try {
				await executor.advance();
			} catch (err) {
				if (err instanceof WorkflowGateError) caught = err;
			}

			expect(caught).toBeDefined();
			expect(caught!.message).toContain('Step A');
		});
	});

	// =========================================================================
	// Cycle support
	// =========================================================================

	describe('cycle support (graph loops)', () => {
		test('can traverse A→B→A cycle', async () => {
			// A and B both have transitions to each other
			// A→B (always), B→A (always) — cycle
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `Cycle-WF-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
				],
				transitions: [
					{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 },
					{ from: STEP_B, to: STEP_A, condition: { type: 'always' }, order: 0 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Cycle Run',
				currentStepId: workflow.startStepId,
			});

			const executor = makeExecutor(workflow, run);

			// Step A → Step B
			const r1 = await executor.advance();
			expect(r1.step.name).toBe('Step B');

			// Step B → Step A (cycle)
			const r2 = await executor.advance();
			expect(r2.step.name).toBe('Step A');

			// Run is not complete — still has outgoing transitions
			expect(executor.isComplete()).toBe(false);
		});
	});

	// =========================================================================
	// Multiple outgoing transitions (first matching wins)
	// =========================================================================

	describe('multiple transitions — first matching wins', () => {
		test('skips failing human condition and follows always fallback', async () => {
			// Step A has two transitions: order 0 is human (blocked), order 1 is always (fallback).
			// The executor should skip the failing human gate and follow the always fallback.
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi-Trans-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
					{ id: STEP_C, name: 'Step C', agentId: AGENT_C },
				],
				transitions: [
					// Order 0 → human condition (not approved → fails)
					{ from: STEP_A, to: STEP_B, condition: { type: 'human' }, order: 0 },
					// Order 1 → always (fallback, should be reached)
					{ from: STEP_A, to: STEP_C, condition: { type: 'always' }, order: 1 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Multi-Trans Run',
				currentStepId: workflow.startStepId,
			});

			const executor = makeExecutor(workflow, run);

			// human at order 0 fails, always at order 1 passes → follows always fallback to Step C
			const result = await executor.advance();
			expect(result.step.name).toBe('Step C');
			expect(runRepo.getRun(run.id)?.status).not.toBe('needs_attention');
		});

		test('marks needs_attention when all transitions fail', async () => {
			// Both outgoing transitions require human approval; neither passes
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi-Trans-AllFail-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
					{ id: STEP_C, name: 'Step C', agentId: AGENT_C },
				],
				transitions: [
					{ from: STEP_A, to: STEP_B, condition: { type: 'human' }, order: 0 },
					{ from: STEP_A, to: STEP_C, condition: { type: 'human' }, order: 1 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'All-Fail Run',
				currentStepId: workflow.startStepId,
			});

			const executor = makeExecutor(workflow, run);

			// Both human conditions fail → needs_attention
			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);
			expect(runRepo.getRun(run.id)?.status).toBe('needs_attention');
		});

		test('follows first passing condition transition when multiple condition transitions exist', async () => {
			// Order 0 fails (exit 1), order 1 passes (exit 0) → follows order 1
			const failThenPass: CommandRunner = (() => {
				let calls = 0;
				return async () => ({ exitCode: ++calls === 1 ? 1 : 0 });
			})();

			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `Multi-Cond-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
					{ id: STEP_C, name: 'Step C', agentId: AGENT_C },
				],
				transitions: [
					{
						from: STEP_A,
						to: STEP_B,
						condition: { type: 'condition', expression: 'check' },
						order: 0,
					},
					{
						from: STEP_A,
						to: STEP_C,
						condition: { type: 'condition', expression: 'check' },
						order: 1,
					},
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'First-Pass Run',
				currentStepId: workflow.startStepId,
			});

			const executor = makeExecutor(workflow, run, failThenPass);
			const result = await executor.advance();
			expect(result.step.name).toBe('Step C');
		});
	});

	// =========================================================================
	// humanApproved flag clearing
	// =========================================================================

	describe('humanApproved flag clearing', () => {
		test('clears humanApproved from run.config after following a human transition', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B, incomingCondition: { type: 'human' } },
			]);
			const approvedRun = runRepo.updateRun(run.id, { config: { humanApproved: true } })!;
			const executor = makeExecutor(workflow, approvedRun);

			await executor.advance();

			// humanApproved should be cleared so a future human gate in a cycle is not auto-passed
			const updated = runRepo.getRun(run.id)!;
			expect(
				(updated.config as Record<string, unknown> | undefined)?.humanApproved
			).toBeUndefined();
		});

		test('does not clear humanApproved when following an always transition', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B, incomingCondition: { type: 'always' } },
			]);
			// Set humanApproved — it should remain untouched after following an always transition
			const approvedRun = runRepo.updateRun(run.id, { config: { humanApproved: true } })!;
			const executor = makeExecutor(workflow, approvedRun);

			await executor.advance();

			const updated = runRepo.getRun(run.id)!;
			expect((updated.config as Record<string, unknown> | undefined)?.humanApproved).toBe(true);
		});
	});

	// =========================================================================
	// Task creation on advance
	// =========================================================================

	describe('task creation on advance', () => {
		test('created task has correct workflowRunId and workflowStepId', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B, instructions: 'Run B things' },
			]);
			const executor = makeExecutor(workflow, run);

			const { step, tasks } = await executor.advance();
			const task = tasks[0];

			expect(task.spaceId).toBe(SPACE_ID);
			expect(task.workflowRunId).toBe(run.id);
			expect(task.workflowStepId).toBe(step.id);
			expect(task.customAgentId).toBe(AGENT_B);
			expect(task.description).toBe('Run B things');
		});

		test('no task created when advancing from terminal step', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Only Step', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);

			const { tasks } = await executor.advance();
			expect(tasks).toHaveLength(0);
		});
	});
});
