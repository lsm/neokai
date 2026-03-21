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
 * - WorkflowTransitionError properties
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
     config, created_at, updated_at, role)
     VALUES (?, ?, ?, '', null, '[]', '', null, ?, ?, 'coder')`
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

			await expect(executor.advance()).rejects.toThrow(WorkflowTransitionError);

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

			await expect(executor.advance()).rejects.toThrow(WorkflowTransitionError);

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

			await expect(executor.advance()).rejects.toThrow(WorkflowTransitionError);

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

			await expect(executor.advance()).rejects.toThrow(WorkflowTransitionError);
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

			// First call: human gate blocks → WorkflowGateError
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
	// WorkflowTransitionError properties
	// =========================================================================

	describe('WorkflowGateError', () => {
		test('human gate throws WorkflowGateError with descriptive message', async () => {
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
			// The executor should skip the unapproved human transition and follow the always fallback.
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

			// Both human conditions fail → WorkflowGateError + needs_attention
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

			// humanApproved should be cleared so a future human transition in a cycle is not auto-passed
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

	// =========================================================================
	// goalId propagation through task creation
	// =========================================================================

	describe('goalId propagation', () => {
		test('task created by advance() inherits goalId from run', async () => {
			const { workflow } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
			]);

			// Create run separately to set goalId
			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Run with goalId',
				currentStepId: workflow.startStepId,
				goalId: 'goal-123',
			});

			const executor = makeExecutor(workflow, run);
			const { tasks } = await executor.advance();

			expect(tasks).toHaveLength(1);
			expect(tasks[0].goalId).toBe('goal-123');
		});

		test('task created by advance() has undefined goalId when run has no goalId', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
				{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
			]);

			// Run created by createLinearWorkflow has no goalId
			expect(run.goalId).toBeUndefined();

			const executor = makeExecutor(workflow, run);
			const { tasks } = await executor.advance();

			expect(tasks).toHaveLength(1);
			expect(tasks[0].goalId).toBeUndefined();
		});

		test('goalId propagates through multiple advance() calls in a three-step workflow', async () => {
			const stepsData = [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_A },
				{ id: STEP_B, name: 'Code', agentId: AGENT_B },
				{ id: STEP_C, name: 'Review', agentId: AGENT_C },
			];

			const transitions = [
				{ from: STEP_A, to: STEP_B, order: 0 },
				{ from: STEP_B, to: STEP_C, order: 0 },
			];

			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: 'WF-goalId-multi',
				steps: stepsData,
				transitions,
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Multi-step goalId run',
				currentStepId: workflow.startStepId,
				goalId: 'goal-multi',
			});

			const executor = makeExecutor(workflow, run);

			// Advance A → B
			const r1 = await executor.advance();
			expect(r1.tasks[0].goalId).toBe('goal-multi');

			// Advance B → C
			const r2 = await executor.advance();
			expect(r2.tasks[0].goalId).toBe('goal-multi');
		});

		test('goalId is undefined for all tasks when run has no goalId in multi-step workflow', async () => {
			const stepsData = [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_A },
				{ id: STEP_B, name: 'Code', agentId: AGENT_B },
				{ id: STEP_C, name: 'Review', agentId: AGENT_C },
			];

			const transitions = [
				{ from: STEP_A, to: STEP_B, order: 0 },
				{ from: STEP_B, to: STEP_C, order: 0 },
			];

			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: 'WF-no-goalId',
				steps: stepsData,
				transitions,
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'No goalId run',
				currentStepId: workflow.startStepId,
			});

			const executor = makeExecutor(workflow, run);

			const r1 = await executor.advance();
			expect(r1.tasks[0].goalId).toBeUndefined();

			const r2 = await executor.advance();
			expect(r2.tasks[0].goalId).toBeUndefined();
		});

		test('goalId propagates correctly through cyclic transitions', async () => {
			// Create a workflow with a cycle: A → B → A
			const stepsData = [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_A },
				{ id: STEP_B, name: 'Verify', agentId: AGENT_B },
			];

			const transitions = [
				{ from: STEP_A, to: STEP_B, order: 0 },
				{ from: STEP_B, to: STEP_A, order: 0 }, // cycle back
			];

			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: 'WF-cyclic-goalId',
				steps: stepsData,
				transitions,
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Cyclic goalId run',
				currentStepId: workflow.startStepId,
				goalId: 'goal-cycle',
			});

			const executor = makeExecutor(workflow, run);

			// A → B
			const r1 = await executor.advance();
			expect(r1.tasks[0].goalId).toBe('goal-cycle');

			// B → A (cycle back)
			const r2 = await executor.advance();
			expect(r2.tasks[0].goalId).toBe('goal-cycle');

			// A → B again
			const r3 = await executor.advance();
			expect(r3.tasks[0].goalId).toBe('goal-cycle');
		});
	});

	// =========================================================================
	// Condition type: task_result
	// =========================================================================

	describe('condition type: task_result', () => {
		test('evaluateCondition: passes when taskResult starts with expression', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = {
				workspacePath: WORKSPACE,
				taskResult: 'passed',
			};
			const result = await executor.evaluateCondition(
				{ type: 'task_result', expression: 'passed' },
				ctx
			);
			expect(result.passed).toBe(true);
		});

		test('evaluateCondition: passes with prefix match (failed: tests broken)', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = {
				workspacePath: WORKSPACE,
				taskResult: 'failed: tests broken',
			};
			const result = await executor.evaluateCondition(
				{ type: 'task_result', expression: 'failed' },
				ctx
			);
			expect(result.passed).toBe(true);
		});

		test('evaluateCondition: fails when taskResult does not match expression', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = {
				workspacePath: WORKSPACE,
				taskResult: 'failed: tests broken',
			};
			const result = await executor.evaluateCondition(
				{ type: 'task_result', expression: 'passed' },
				ctx
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('does not match');
			expect(result.reason).toContain('failed: tests broken');
			expect(result.reason).toContain('passed');
		});

		test('evaluateCondition: fails when expression is empty', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = {
				workspacePath: WORKSPACE,
				taskResult: 'passed',
			};
			const result = await executor.evaluateCondition({ type: 'task_result', expression: '' }, ctx);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('non-empty expression');
		});

		test('evaluateCondition: fails when expression is undefined', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = {
				workspacePath: WORKSPACE,
				taskResult: 'passed',
			};
			const result = await executor.evaluateCondition({ type: 'task_result' }, ctx);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('non-empty expression');
		});

		test('task_result retries are short-circuited (maxRetries has no effect)', async () => {
			// task_result context doesn't change between retries, so maxRetries should be ignored.
			// Verify that advance() only evaluates the condition once even with maxRetries set.
			const steps = [
				{ id: STEP_A, name: 'Verify', agentId: AGENT_A },
				{ id: STEP_B, name: 'Next', agentId: AGENT_B },
			];
			const transitions = [
				{
					from: STEP_A,
					to: STEP_B,
					condition: {
						type: 'task_result' as const,
						expression: 'passed',
						maxRetries: 5,
					},
					order: 0,
				},
			];

			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-retry-${Date.now()}`,
				steps,
				transitions,
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Retry Test',
				currentStepId: workflow.startStepId,
			});

			// Complete a task with 'failed' — won't match 'passed'
			const verifyStepId = workflow.steps.find((s) => s.name === 'Verify')!.id;
			const task = await taskManager.createTask({
				title: 'Verify',
				description: '',
				workflowRunId: run.id,
				workflowStepId: verifyStepId,
				status: 'pending',
			});
			await taskManager.setTaskStatus(task.id, 'in_progress');
			await taskManager.completeTask(task.id, 'failed');

			const executor = makeExecutor(workflow, run);
			// Should fail immediately (not retry 5 times) since taskResult won't change
			await expect(executor.advance()).rejects.toThrow(WorkflowTransitionError);
		});

		test('evaluateCondition: fails when taskResult is undefined', async () => {
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
			]);
			const executor = makeExecutor(workflow, run);
			const ctx: ConditionContext = { workspacePath: WORKSPACE };
			const result = await executor.evaluateCondition(
				{ type: 'task_result', expression: 'passed' },
				ctx
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('No task result available');
		});
	});

	// =========================================================================
	// advance() with task_result — DB and fallback resolution
	// =========================================================================

	describe('advance() with task_result conditions', () => {
		/**
		 * Helper: creates a workflow with A → B where A→B has a task_result condition,
		 * creates a completed task on step A with the given result, then returns the executor.
		 */
		async function setupTaskResultWorkflow(opts: {
			taskResultOnStep?: string;
			conditionExpression: string;
		}) {
			const steps = [
				{ id: STEP_A, name: 'Verify', agentId: AGENT_A },
				{ id: STEP_B, name: 'Next', agentId: AGENT_B },
			];
			const transitions = [
				{
					from: STEP_A,
					to: STEP_B,
					condition: {
						type: 'task_result' as const,
						expression: opts.conditionExpression,
					},
					order: 0,
				},
			];

			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-task-result-${Date.now()}`,
				steps,
				transitions,
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Task Result Test Run',
				currentStepId: workflow.startStepId,
			});

			// Create a task on step A and complete it with a result
			if (opts.taskResultOnStep !== undefined) {
				const task = await taskManager.createTask({
					title: 'Verify Task',
					description: 'Verify work',
					workflowRunId: run.id,
					workflowStepId: workflow.steps.find((s) => s.name === 'Verify')!.id,
					status: 'pending',
				});
				await taskManager.setTaskStatus(task.id, 'in_progress');
				await taskManager.completeTask(task.id, opts.taskResultOnStep);
			}

			const executor = makeExecutor(workflow, run);
			return { workflow, run, executor };
		}

		test('advance() resolves taskResult from DB and follows matching transition', async () => {
			const { executor } = await setupTaskResultWorkflow({
				taskResultOnStep: 'passed',
				conditionExpression: 'passed',
			});

			const result = await executor.advance();
			expect(result.step.name).toBe('Next');
			expect(result.tasks).toHaveLength(1);
		});

		test('advance() resolves taskResult from DB with prefix match', async () => {
			const { executor } = await setupTaskResultWorkflow({
				taskResultOnStep: 'failed: linting errors found',
				conditionExpression: 'failed',
			});

			const result = await executor.advance();
			expect(result.step.name).toBe('Next');
		});

		test('advance() uses stepResult fallback when no DB result', async () => {
			// No completed task on the step — taskResult comes from options.stepResult
			const steps = [
				{ id: STEP_A, name: 'Verify', agentId: AGENT_A },
				{ id: STEP_B, name: 'Next', agentId: AGENT_B },
			];
			const transitions = [
				{
					from: STEP_A,
					to: STEP_B,
					condition: {
						type: 'task_result' as const,
						expression: 'passed',
					},
					order: 0,
				},
			];

			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-fallback-${Date.now()}`,
				steps,
				transitions,
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Fallback Test Run',
				currentStepId: workflow.startStepId,
			});

			const executor = makeExecutor(workflow, run);
			const result = await executor.advance({ stepResult: 'passed' });
			expect(result.step.name).toBe('Next');
		});

		test('advance() DB result takes priority over stepResult fallback', async () => {
			const { executor } = await setupTaskResultWorkflow({
				taskResultOnStep: 'failed: real DB result',
				conditionExpression: 'failed',
			});

			// Even though stepResult says 'passed', the DB result 'failed: ...' is used
			const result = await executor.advance({ stepResult: 'passed' });
			expect(result.step.name).toBe('Next');
		});

		test('advance() sets needs_attention when task_result does not match', async () => {
			const { executor, run } = await setupTaskResultWorkflow({
				taskResultOnStep: 'failed: tests broken',
				conditionExpression: 'passed',
			});

			await expect(executor.advance()).rejects.toThrow(WorkflowTransitionError);
			expect(runRepo.getRun(run.id)?.status).toBe('needs_attention');
		});

		test('advance() sets needs_attention when no task result and no fallback', async () => {
			// No completed task on step, no stepResult fallback
			const steps = [
				{ id: STEP_A, name: 'Verify', agentId: AGENT_A },
				{ id: STEP_B, name: 'Next', agentId: AGENT_B },
			];
			const transitions = [
				{
					from: STEP_A,
					to: STEP_B,
					condition: {
						type: 'task_result' as const,
						expression: 'passed',
					},
					order: 0,
				},
			];

			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-no-result-${Date.now()}`,
				steps,
				transitions,
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'No Result Test Run',
				currentStepId: workflow.startStepId,
			});

			const executor = makeExecutor(workflow, run);
			await expect(executor.advance()).rejects.toThrow(WorkflowTransitionError);
			expect(runRepo.getRun(run.id)?.status).toBe('needs_attention');
		});

		test('advance() picks most recently completed task when multiple exist', async () => {
			const steps = [
				{ id: STEP_A, name: 'Verify', agentId: AGENT_A },
				{ id: STEP_B, name: 'Next', agentId: AGENT_B },
			];
			const transitions = [
				{
					from: STEP_A,
					to: STEP_B,
					condition: {
						type: 'task_result' as const,
						expression: 'passed',
					},
					order: 0,
				},
			];

			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-multi-tasks-${Date.now()}`,
				steps,
				transitions,
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Multi Tasks Run',
				currentStepId: workflow.startStepId,
			});

			const verifyStepId = workflow.steps.find((s) => s.name === 'Verify')!.id;

			// Create first task, complete with 'failed'
			const task1 = await taskManager.createTask({
				title: 'Verify 1',
				description: 'First try',
				workflowRunId: run.id,
				workflowStepId: verifyStepId,
				status: 'pending',
			});
			await taskManager.setTaskStatus(task1.id, 'in_progress');
			await taskManager.completeTask(task1.id, 'failed: first attempt');
			// Force a deterministic earlier completedAt via direct DB update
			db.prepare('UPDATE space_tasks SET completed_at = ? WHERE id = ?').run(1000, task1.id);

			// Create second task, complete with 'passed'
			const task2 = await taskManager.createTask({
				title: 'Verify 2',
				description: 'Second try',
				workflowRunId: run.id,
				workflowStepId: verifyStepId,
				status: 'pending',
			});
			await taskManager.setTaskStatus(task2.id, 'in_progress');
			await taskManager.completeTask(task2.id, 'passed');
			// Force a deterministic later completedAt via direct DB update
			db.prepare('UPDATE space_tasks SET completed_at = ? WHERE id = ?').run(2000, task2.id);

			const executor = makeExecutor(workflow, run);
			// Should use 'passed' from the most recently completed task
			const result = await executor.advance();
			expect(result.step.name).toBe('Next');
		});

		test('existing condition types continue to work unchanged', async () => {
			// Verify that 'always', 'human', and 'condition' still work
			const { workflow, run } = createLinearWorkflow([
				{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
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
	});

	// =========================================================================
	// isCyclic transition — iteration counting and maxIterations cap
	// =========================================================================

	describe('isCyclic transition — iteration counting', () => {
		test('iterationCount is incremented when following isCyclic transition', async () => {
			// A→B→A cycle where both transitions are marked isCyclic
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-cyclic-iter-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
				],
				transitions: [
					{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, isCyclic: true, order: 0 },
					{ from: STEP_B, to: STEP_A, condition: { type: 'always' }, isCyclic: true, order: 0 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Cyclic Iteration Test',
				currentStepId: workflow.startStepId,
			});

			const executor = makeExecutor(workflow, run);

			// A → B (isCyclic, iterationCount becomes 1)
			await executor.advance();
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(1);

			// B → A (isCyclic, iterationCount becomes 2)
			await executor.advance();
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(2);

			// A → B again (isCyclic, iterationCount becomes 3)
			await executor.advance();
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(3);
		});

		test('non-cyclic transition does not increment iterationCount', async () => {
			// A→B→C linear workflow with no cyclic transitions
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-linear-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
					{ id: STEP_C, name: 'Step C', agentId: AGENT_C },
				],
				transitions: [
					{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 },
					{ from: STEP_B, to: STEP_C, condition: { type: 'always' }, order: 0 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Linear No Iteration',
				currentStepId: workflow.startStepId,
			});

			const executor = makeExecutor(workflow, run);

			await executor.advance(); // A → B
			await executor.advance(); // B → C
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(0);
		});

		test('transition with isCyclic: false does not increment iterationCount', async () => {
			// A→B where the transition explicitly sets isCyclic: false
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-explicit-false-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
				],
				transitions: [
					{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, isCyclic: false, order: 0 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Explicit isCyclic False',
				currentStepId: workflow.startStepId,
			});

			const executor = makeExecutor(workflow, run);

			await executor.advance(); // A → B
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(0);
		});

		test('iterationCount reaches maxIterations and sets needs_attention', async () => {
			// A→B→A cycle where both transitions are cyclic, maxIterations=2
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-cap-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
				],
				transitions: [
					{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, isCyclic: true, order: 0 },
					{ from: STEP_B, to: STEP_A, condition: { type: 'always' }, isCyclic: true, order: 0 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Iteration Cap Test',
				currentStepId: workflow.startStepId,
				maxIterations: 2,
			});

			const executor = makeExecutor(workflow, run);

			// A → B (isCyclic, iterationCount = 1)
			await executor.advance();
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(1);

			// B → A (isCyclic, iterationCount = 2 which equals maxIterations)
			// Should throw WorkflowTransitionError and set needs_attention
			await expect(executor.advance()).rejects.toThrow(WorkflowTransitionError);
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(2);
			expect(runRepo.getRun(run.id)?.status).toBe('needs_attention');
		});

		test('no task is created when iteration cap is hit', async () => {
			// Verify that no new task is created when the iteration cap is reached
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-no-task-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
				],
				transitions: [
					{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, isCyclic: true, order: 0 },
					{ from: STEP_B, to: STEP_A, condition: { type: 'always' }, isCyclic: true, order: 0 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'No Task On Cap',
				currentStepId: workflow.startStepId,
				maxIterations: 1,
			});

			const executor = makeExecutor(workflow, run);

			// A → B (isCyclic, iterationCount = 1 which equals maxIterations=1)
			// Should throw before creating any task
			await expect(executor.advance()).rejects.toThrow(WorkflowTransitionError);

			// Count tasks - should be 0 because no task was created when cap was hit
			const tasks = await taskManager.listTasksByWorkflowRun(run.id);
			expect(tasks).toHaveLength(0);
		});

		test('WorkflowTransitionError message includes iteration info when cap is hit', async () => {
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-err-msg-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Plan', agentId: AGENT_A },
					{ id: STEP_B, name: 'Verify', agentId: AGENT_B },
				],
				transitions: [
					{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, isCyclic: true, order: 0 },
					{ from: STEP_B, to: STEP_A, condition: { type: 'always' }, isCyclic: true, order: 0 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Error Message Test',
				currentStepId: workflow.startStepId,
				maxIterations: 1,
			});

			const executor = makeExecutor(workflow, run);

			// A → B (isCyclic, cap hit since maxIterations=1)
			let caughtError: WorkflowTransitionError | undefined;
			try {
				await executor.advance();
			} catch (err) {
				if (err instanceof WorkflowTransitionError) {
					caughtError = err;
				}
			}

			expect(caughtError).toBeDefined();
			expect(caughtError!.message).toContain('Iteration cap reached');
			expect(caughtError!.message).toContain('1/1');
			expect(caughtError!.message).toContain('cyclic transition');
		});

		test('advance() re-reads maxIterations from DB on each call', async () => {
			// Create a workflow with a cycle where both transitions are cyclic
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-reload-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
				],
				transitions: [
					{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, isCyclic: true, order: 0 },
					{ from: STEP_B, to: STEP_A, condition: { type: 'always' }, isCyclic: true, order: 0 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Reload maxIterations Test',
				currentStepId: workflow.startStepId,
				maxIterations: 3,
			});

			const executor = makeExecutor(workflow, run);

			// A → B (isCyclic, iterationCount = 1)
			await executor.advance();

			// B → A (isCyclic, iterationCount = 2)
			await executor.advance();
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(2);

			// Simulate human increasing maxIterations to 5 via direct DB update
			runRepo.updateRun(run.id, { maxIterations: 5 });

			// A → B again (isCyclic, iterationCount = 3 which equals original maxIterations=3)
			// But advance() re-reads from DB, so maxIterations is now 5 and this should succeed
			await executor.advance();
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(3);

			// B → A again (isCyclic, iterationCount = 4)
			await executor.advance();
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(4);
		});

		test('iterationCount is NOT reset when run is reset to in_progress', async () => {
			// Verify iterationCount persists across status resets
			const workflow = workflowRepo.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF-persist-${Date.now()}`,
				steps: [
					{ id: STEP_A, name: 'Step A', agentId: AGENT_A },
					{ id: STEP_B, name: 'Step B', agentId: AGENT_B },
				],
				transitions: [
					{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, isCyclic: true, order: 0 },
					{ from: STEP_B, to: STEP_A, condition: { type: 'always' }, isCyclic: true, order: 0 },
				],
				startStepId: STEP_A,
			});

			const run = runRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Iteration Count Persist Test',
				currentStepId: workflow.startStepId,
				maxIterations: 5,
			});

			const executor = makeExecutor(workflow, run);

			// A → B (isCyclic, iterationCount = 1)
			await executor.advance();

			// B → A (isCyclic, iterationCount = 2)
			await executor.advance();
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(2);

			// Human resets run to in_progress (iterationCount should NOT reset)
			runRepo.updateStatus(run.id, 'in_progress');

			// Simulate new executor being created (re-reads from DB)
			const freshExecutor = makeExecutor(workflow, runRepo.getRun(run.id)!);

			// A → B again (isCyclic, iterationCount = 3)
			await freshExecutor.advance();
			expect(runRepo.getRun(run.id)?.iterationCount).toBe(3);
		});
	});
});
