/**
 * WorkflowExecutor Unit Tests
 *
 * Covers:
 * - Multi-step progression (advance through all steps)
 * - Gate types: auto, human_approval, quality_check, pr_review, custom
 * - Security: reject non-allowlisted commands, path traversal, absolute paths, shell metacharacters
 * - Timeout enforcement on shell-executing gates
 * - Retry logic: re-evaluate gate only, after exhaustion → needs_attention
 * - Completion detection (isComplete, isComplete after last step)
 * - canAdvance / canEnterStep checks
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
	GateContext,
} from '../../../src/lib/space/runtime/workflow-executor.ts';
import { GATE_QUALITY_CHECK_ALLOWLIST } from '../../../src/lib/space/runtime/gate-allowlist.ts';
import type { SpaceWorkflow, SpaceWorkflowRun, WorkflowGate } from '@neokai/shared';

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
// Fixtures and mock helpers
// ---------------------------------------------------------------------------

/** Returns a no-op command runner (always exits 0) */
function makeOkRunner(): CommandRunner {
	return async () => ({ exitCode: 0 });
}

/** Returns a command runner that always fails with a given exit code */
function makeFailRunner(exitCode = 1): CommandRunner {
	return async () => ({ exitCode });
}

/** Returns a command runner that simulates a timeout */
function makeTimeoutRunner(): CommandRunner {
	return async () => ({ exitCode: null, timedOut: true });
}

/**
 * Returns a command runner that succeeds after `failTimes` failures.
 * Useful for testing retry logic.
 */
function makeRetryRunner(failTimes: number): CommandRunner {
	let calls = 0;
	return async () => {
		calls++;
		if (calls <= failTimes) return { exitCode: 1 };
		return { exitCode: 0 };
	};
}

/** Creates a WorkflowGate fixture */
function makeGate(overrides: Partial<WorkflowGate> = {}): WorkflowGate {
	return { type: 'auto', ...overrides };
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
	const AGENT_ID_A = 'agent-a';
	const AGENT_ID_B = 'agent-b';
	const AGENT_ID_C = 'agent-c';

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID, WORKSPACE);
		seedAgent(db, AGENT_ID_A, SPACE_ID, 'Agent A');
		seedAgent(db, AGENT_ID_B, SPACE_ID, 'Agent B');
		seedAgent(db, AGENT_ID_C, SPACE_ID, 'Agent C');

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
	// Helper to build an executor with optional runner override
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

	function createWorkflowAndRun(
		steps: {
			name: string;
			agentId: string;
			entryGate?: WorkflowGate;
			exitGate?: WorkflowGate;
			instructions?: string;
		}[],
		title = 'Test Run'
	): { workflow: SpaceWorkflow; run: SpaceWorkflowRun } {
		const workflow = workflowRepo.createWorkflow({
			spaceId: SPACE_ID,
			name: `Workflow-${Date.now()}`,
			steps: steps.map((s) => ({
				name: s.name,
				agentId: s.agentId,
				entryGate: s.entryGate,
				exitGate: s.exitGate,
				instructions: s.instructions,
			})),
		});
		const run = runRepo.createRun({
			spaceId: SPACE_ID,
			workflowId: workflow.id,
			title,
		});
		return { workflow, run };
	}

	// =========================================================================
	// Navigation
	// =========================================================================

	describe('getCurrentStep / getNextStep / isComplete', () => {
		test('getCurrentStep returns step at currentStepIndex', () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run);
			expect(executor.getCurrentStep()?.name).toBe('Step A');
		});

		test('getNextStep returns the step after current', () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run);
			expect(executor.getNextStep()?.name).toBe('Step B');
		});

		test('getNextStep returns null when on last step', () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Only Step', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			expect(executor.getNextStep()).toBeNull();
		});

		test('isComplete returns false at start of multi-step workflow', () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run);
			expect(executor.isComplete()).toBe(false);
		});

		test('isComplete returns true when run status is completed', () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const completedRun = { ...run, status: 'completed' as const };
			const executor = makeExecutor(workflow, completedRun);
			expect(executor.isComplete()).toBe(true);
		});

		test('isComplete returns true when run status is cancelled', () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const cancelledRun = { ...run, status: 'cancelled' as const };
			const executor = makeExecutor(workflow, cancelledRun);
			expect(executor.isComplete()).toBe(true);
		});
	});

	// =========================================================================
	// Multi-step progression
	// =========================================================================

	describe('advance — multi-step progression', () => {
		test('advances from step 0 to step 1 and creates pending task', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A, instructions: 'Do A' },
				{ name: 'Step B', agentId: AGENT_ID_B, instructions: 'Do B' },
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
			expect(result.tasks[0].customAgentId).toBe(AGENT_ID_B);
		});

		test('advance updates currentStepIndex in DB', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run);

			await executor.advance();

			const updated = runRepo.getRun(run.id);
			expect(updated?.currentStepIndex).toBe(1);
		});

		test('advances through all 3 steps', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{ name: 'Step B', agentId: AGENT_ID_B },
				{ name: 'Step C', agentId: AGENT_ID_C },
			]);
			const executor = makeExecutor(workflow, run);

			const r1 = await executor.advance();
			expect(r1.step.name).toBe('Step B');

			const r2 = await executor.advance();
			expect(r2.step.name).toBe('Step C');

			// advance from last step → completion
			const r3 = await executor.advance();
			expect(r3.tasks).toHaveLength(0); // no next step
			expect(executor.isComplete()).toBe(true);
		});

		test('advance on last step marks run as completed', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Only Step', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);

			await executor.advance();

			const updated = runRepo.getRun(run.id);
			expect(updated?.status).toBe('completed');
			expect(executor.isComplete()).toBe(true);
		});

		test('getCurrentStep reflects new index after advance', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run);

			expect(executor.getCurrentStep()?.name).toBe('Step A');
			await executor.advance();
			expect(executor.getCurrentStep()?.name).toBe('Step B');
		});

		test('advance throws when workflow is already complete', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Only Step', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			await executor.advance(); // completes

			await expect(executor.advance()).rejects.toThrow('already complete');
		});
	});

	// =========================================================================
	// canAdvance / canEnterStep
	// =========================================================================

	describe('canAdvance / canEnterStep', () => {
		test('canAdvance returns true when current step has no exit gate', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			expect(await executor.canAdvance()).toEqual({ allowed: true });
		});

		test('canAdvance returns false with reason when no current step', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			// Manually advance past all steps
			const completedRun = { ...run, currentStepIndex: 99 };
			const executor = makeExecutor(workflow, completedRun);
			const result = await executor.canAdvance();
			expect(result.allowed).toBe(false);
		});

		test('canEnterStep returns true when step has no entry gate', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run);
			expect(await executor.canEnterStep(0)).toEqual({ allowed: true });
			expect(await executor.canEnterStep(1)).toEqual({ allowed: true });
		});

		test('canEnterStep returns false for out-of-range index', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			const result = await executor.canEnterStep(5);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('No step at index 5');
		});
	});

	// =========================================================================
	// Gate type: auto
	// =========================================================================

	describe('evaluateGate — auto', () => {
		test('auto gate always passes', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			const ctx: GateContext = { workspacePath: WORKSPACE };
			const result = await executor.evaluateGate({ type: 'auto' }, ctx);
			expect(result.passed).toBe(true);
		});
	});

	// =========================================================================
	// Gate type: human_approval
	// =========================================================================

	describe('evaluateGate — human_approval', () => {
		test('passes when humanApproved is true in context', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			const ctx: GateContext = { workspacePath: WORKSPACE, humanApproved: true };
			const result = await executor.evaluateGate({ type: 'human_approval' }, ctx);
			expect(result.passed).toBe(true);
		});

		test('fails when humanApproved is false', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			const ctx: GateContext = { workspacePath: WORKSPACE, humanApproved: false };
			const result = await executor.evaluateGate({ type: 'human_approval' }, ctx);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('human approval');
		});

		test('fails when humanApproved is absent', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			const ctx: GateContext = { workspacePath: WORKSPACE };
			const result = await executor.evaluateGate({ type: 'human_approval' }, ctx);
			expect(result.passed).toBe(false);
		});

		test('advance blocks on human_approval exit gate and marks needs_attention', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{
					name: 'Step A',
					agentId: AGENT_ID_A,
					exitGate: makeGate({ type: 'human_approval' }),
				},
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			// run.config has no humanApproved
			const executor = makeExecutor(workflow, run);

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			const updated = runRepo.getRun(run.id);
			expect(updated?.status).toBe('needs_attention');
		});

		test('advance passes when run.config.humanApproved is true', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{
					name: 'Step A',
					agentId: AGENT_ID_A,
					exitGate: makeGate({ type: 'human_approval' }),
				},
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			// Simulate human setting approval in the run config
			const approvedRun = runRepo.updateRun(run.id, {
				config: { humanApproved: true },
			})!;

			const executor = makeExecutor(workflow, approvedRun);
			const result = await executor.advance();
			expect(result.step.name).toBe('Step B');
		});
	});

	// =========================================================================
	// Gate type: pr_review
	// =========================================================================

	describe('evaluateGate — pr_review', () => {
		test('passes when prApproved is true in context', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			const ctx: GateContext = { workspacePath: WORKSPACE, prApproved: true };
			const result = await executor.evaluateGate({ type: 'pr_review' }, ctx);
			expect(result.passed).toBe(true);
		});

		test('fails when prApproved is false', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			const ctx: GateContext = { workspacePath: WORKSPACE, prApproved: false };
			const result = await executor.evaluateGate({ type: 'pr_review' }, ctx);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('PR review');
		});
	});

	// =========================================================================
	// Gate type: quality_check
	// =========================================================================

	describe('evaluateGate — quality_check', () => {
		test('passes when command exits with code 0', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'quality_check', command: 'bun test' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(true);
		});

		test('fails when command exits with non-zero code', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeFailRunner(1));
			const result = await executor.evaluateGate(
				{ type: 'quality_check', command: 'bun test' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('code 1');
		});

		test('fails when command is empty', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			const result = await executor.evaluateGate(
				{ type: 'quality_check', command: '' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('no command');
		});

		test('passes for all default allowlisted commands', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			for (const cmd of GATE_QUALITY_CHECK_ALLOWLIST) {
				const executor = makeExecutor(workflow, run, makeOkRunner());
				const result = await executor.evaluateGate(
					{ type: 'quality_check', command: cmd },
					{ workspacePath: WORKSPACE }
				);
				expect(result.passed).toBe(true);
			}
		});

		// ----- Security tests -----

		test('SECURITY: rejects non-allowlisted command', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner()); // runner would succeed but should never be called
			const result = await executor.evaluateGate(
				{ type: 'quality_check', command: 'rm -rf /tmp/danger' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('allowlist');
		});

		test('SECURITY: rejects allowlisted prefix with extra arguments (exact-match enforcement)', async () => {
			// 'bun test /etc/shadow' starts with 'bun test' but must NOT pass because
			// extra arguments could be exploited to read or execute arbitrary paths.
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'quality_check', command: 'bun test /etc/shadow' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('allowlist');
		});

		test('SECURITY: rejects command with shell pipe metacharacter', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'quality_check', command: 'bun test | grep pass' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
		});

		test('SECURITY: rejects command with semicolon', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'quality_check', command: 'bun test; rm -rf /' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
		});

		test('SECURITY: rejects command with backtick injection', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'quality_check', command: 'bun test `whoami`' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
		});

		test('SECURITY: rejects command with dollar sign', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'quality_check', command: 'bun test $HOME' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
		});
	});

	// =========================================================================
	// Gate type: custom
	// =========================================================================

	describe('evaluateGate — custom', () => {
		test('passes when script exits with code 0', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'custom', command: './scripts/verify.sh' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(true);
		});

		test('fails when script exits with non-zero code', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeFailRunner(2));
			const result = await executor.evaluateGate(
				{ type: 'custom', command: './scripts/verify.sh' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('code 2');
		});

		// ----- Security tests -----

		test('SECURITY: rejects absolute path', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'custom', command: '/etc/passwd' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('relative path');
		});

		test('SECURITY: rejects path with .. traversal', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'custom', command: './scripts/../../etc/shadow' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('..');
		});

		test('SECURITY: rejects path not starting with ./', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'custom', command: 'scripts/verify.sh' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('./');
		});

		test('SECURITY: rejects path with shell metacharacter &', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'custom', command: './ok.sh & rm -rf /' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('metacharacter');
		});

		test('SECURITY: rejects command with newline', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeOkRunner());
			const result = await executor.evaluateGate(
				{ type: 'custom', command: './ok.sh\nrm -rf /' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
		});

		test('fails when command is empty', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			const result = await executor.evaluateGate(
				{ type: 'custom', command: '' },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('no command');
		});
	});

	// =========================================================================
	// Timeout enforcement
	// =========================================================================

	describe('timeout enforcement', () => {
		test('quality_check gate fails when command times out', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeTimeoutRunner());
			const result = await executor.evaluateGate(
				{ type: 'quality_check', command: 'bun test', timeoutMs: 5000 },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('timed out');
		});

		test('custom gate fails when script times out', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Step A', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run, makeTimeoutRunner());
			const result = await executor.evaluateGate(
				{ type: 'custom', command: './scripts/slow.sh', timeoutMs: 1000 },
				{ workspacePath: WORKSPACE }
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain('timed out');
		});

		test('advance marks run as needs_attention when exit gate times out', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{
					name: 'Step A',
					agentId: AGENT_ID_A,
					exitGate: makeGate({ type: 'quality_check', command: 'bun test', timeoutMs: 100 }),
				},
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run, makeTimeoutRunner());

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			const updated = runRepo.getRun(run.id);
			expect(updated?.status).toBe('needs_attention');
		});
	});

	// =========================================================================
	// Retry logic
	// =========================================================================

	describe('retry logic', () => {
		test('gate passes after failing twice with maxRetries=2', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{
					name: 'Step A',
					agentId: AGENT_ID_A,
					exitGate: makeGate({
						type: 'quality_check',
						command: 'bun test',
						maxRetries: 2,
					}),
				},
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			// Fails first 2 attempts, passes on 3rd
			const executor = makeExecutor(workflow, run, makeRetryRunner(2));

			const result = await executor.advance();
			expect(result.step.name).toBe('Step B');
		});

		test('gate fails after exhausting all retries → needs_attention', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{
					name: 'Step A',
					agentId: AGENT_ID_A,
					exitGate: makeGate({
						type: 'quality_check',
						command: 'bun test',
						maxRetries: 1, // 2 total attempts
					}),
				},
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			// Fails first 3 attempts — more than maxRetries allows
			const executor = makeExecutor(workflow, run, makeRetryRunner(3));

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			const updated = runRepo.getRun(run.id);
			expect(updated?.status).toBe('needs_attention');
		});

		test('entry gate retried on advance', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{
					name: 'Step B',
					agentId: AGENT_ID_B,
					entryGate: makeGate({
						type: 'quality_check',
						command: 'bun test',
						maxRetries: 2,
					}),
				},
			]);
			// Fails first 2 attempts, passes on 3rd
			const executor = makeExecutor(workflow, run, makeRetryRunner(2));

			const result = await executor.advance();
			expect(result.step.name).toBe('Step B');
		});

		test('no retry by default (maxRetries=0) — single attempt', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{
					name: 'Step A',
					agentId: AGENT_ID_A,
					exitGate: makeGate({
						type: 'quality_check',
						command: 'bun test',
						// maxRetries not set → defaults to 0 (1 attempt total)
					}),
				},
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			// Fails on first attempt only — with no retries this should fail
			const executor = makeExecutor(workflow, run, makeRetryRunner(1));

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);
		});

		test('retry re-evaluates gate only, does NOT re-run the agent', async () => {
			// The command runner call count reflects gate re-evaluations.
			let callCount = 0;
			const runner: CommandRunner = async () => {
				callCount++;
				return { exitCode: callCount >= 3 ? 0 : 1 }; // pass on 3rd call
			};

			const { workflow, run } = createWorkflowAndRun([
				{
					name: 'Step A',
					agentId: AGENT_ID_A,
					exitGate: makeGate({
						type: 'quality_check',
						command: 'bun test',
						maxRetries: 3,
					}),
				},
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run, runner);

			await executor.advance();

			// 3 gate evaluations (2 fail + 1 pass) — NOT more (would indicate agent re-run)
			expect(callCount).toBe(3);
		});
	});

	// =========================================================================
	// Completion detection
	// =========================================================================

	describe('completion detection', () => {
		test('single-step workflow completes after one advance', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Only Step', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);

			expect(executor.isComplete()).toBe(false);
			await executor.advance();
			expect(executor.isComplete()).toBe(true);
		});

		test('three-step workflow completes after three advances', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{ name: 'Step B', agentId: AGENT_ID_B },
				{ name: 'Step C', agentId: AGENT_ID_C },
			]);
			const executor = makeExecutor(workflow, run);

			await executor.advance();
			expect(executor.isComplete()).toBe(false);
			await executor.advance();
			expect(executor.isComplete()).toBe(false);
			await executor.advance();
			expect(executor.isComplete()).toBe(true);
		});

		test('getCurrentStep returns null after completion', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Only Step', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			await executor.advance();

			expect(executor.getCurrentStep()).toBeNull();
		});

		test('getNextStep returns null after completion', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Only Step', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);
			await executor.advance();

			expect(executor.getNextStep()).toBeNull();
		});
	});

	// =========================================================================
	// Task creation
	// =========================================================================

	describe('task creation on advance', () => {
		test('created task has correct workflowRunId and workflowStepId', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{ name: 'Step B', agentId: AGENT_ID_B, instructions: 'Run B things' },
			]);
			const executor = makeExecutor(workflow, run);

			const { step, tasks } = await executor.advance();
			const task = tasks[0];

			expect(task.spaceId).toBe(SPACE_ID);
			expect(task.workflowRunId).toBe(run.id);
			expect(task.workflowStepId).toBe(step.id);
			expect(task.customAgentId).toBe(AGENT_ID_B);
			expect(task.description).toBe('Run B things');
		});

		test('created task uses empty string when step has no instructions', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run);

			const { tasks } = await executor.advance();
			expect(tasks[0].description).toBe('');
		});

		test('no task created when advancing from last step (completion)', async () => {
			const { workflow, run } = createWorkflowAndRun([{ name: 'Only Step', agentId: AGENT_ID_A }]);
			const executor = makeExecutor(workflow, run);

			const { tasks } = await executor.advance();
			expect(tasks).toHaveLength(0);
		});
	});

	// =========================================================================
	// canEnterStep with gates
	// =========================================================================

	describe('canEnterStep with gates', () => {
		test('canEnterStep evaluates entry gate and returns result', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{
					name: 'Step B',
					agentId: AGENT_ID_B,
					entryGate: makeGate({ type: 'human_approval' }),
				},
			]);
			const executor = makeExecutor(workflow, run);

			// Entry gate requires human approval — not set
			const result = await executor.canEnterStep(1);
			expect(result.allowed).toBe(false);
		});

		test('canEnterStep passes when entry gate is auto', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{
					name: 'Step B',
					agentId: AGENT_ID_B,
					entryGate: makeGate({ type: 'auto' }),
				},
			]);
			const executor = makeExecutor(workflow, run);
			const result = await executor.canEnterStep(1);
			expect(result.allowed).toBe(true);
		});
	});

	// =========================================================================
	// needs_attention guard
	// =========================================================================

	describe('needs_attention guard', () => {
		test('advance() throws after a gate failure sets needs_attention', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{
					name: 'Step A',
					agentId: AGENT_ID_A,
					exitGate: makeGate({ type: 'human_approval' }),
				},
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run);

			// First call: gate fails → WorkflowGateError, run → needs_attention
			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			// Second call: must throw because run is now needs_attention,
			// NOT silently re-evaluate the gate
			await expect(executor.advance()).rejects.toThrow('needs_attention');
		});

		test('advance() does not set needs_attention again on second call', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{
					name: 'Step A',
					agentId: AGENT_ID_A,
					exitGate: makeGate({ type: 'human_approval' }),
				},
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run);

			await expect(executor.advance()).rejects.toThrow(WorkflowGateError);

			// Run is needs_attention; second call should throw but NOT change status
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
		test('exit gate failure has gatePosition = exit', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{
					name: 'Step A',
					agentId: AGENT_ID_A,
					exitGate: makeGate({ type: 'human_approval' }),
				},
				{ name: 'Step B', agentId: AGENT_ID_B },
			]);
			const executor = makeExecutor(workflow, run);

			let caught: WorkflowGateError | undefined;
			try {
				await executor.advance();
			} catch (err) {
				if (err instanceof WorkflowGateError) caught = err;
			}

			expect(caught).toBeDefined();
			expect(caught!.gatePosition).toBe('exit');
		});

		test('entry gate failure has gatePosition = entry', async () => {
			const { workflow, run } = createWorkflowAndRun([
				{ name: 'Step A', agentId: AGENT_ID_A },
				{
					name: 'Step B',
					agentId: AGENT_ID_B,
					entryGate: makeGate({ type: 'human_approval' }),
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
			expect(caught!.gatePosition).toBe('entry');
		});
	});
});
