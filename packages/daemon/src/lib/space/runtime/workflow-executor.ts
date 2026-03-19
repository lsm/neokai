/**
 * WorkflowExecutor
 *
 * Manages workflow run progression within a Space.  It advances a
 * SpaceWorkflowRun through its ordered steps, evaluating entry/exit gates
 * at each boundary and creating SpaceTask DB records for each new step.
 *
 * Responsibilities:
 * - Step navigation (getCurrentStep, getNextStep, isComplete)
 * - Gate evaluation with security enforcement (allowlist, path traversal)
 * - Timeout enforcement on shell-executing gates
 * - Retry logic: re-evaluate gate only (NOT re-run agent)
 * - Persisting step index on SpaceWorkflowRun after advance
 * - Creating SpaceTask records (pending only) — does NOT spawn sessions
 */

import type {
	SpaceWorkflow,
	SpaceWorkflowRun,
	SpaceTask,
	WorkflowGate,
	WorkflowStep,
} from '@neokai/shared';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import {
	GATE_QUALITY_CHECK_ALLOWLIST,
	DEFAULT_GATE_TIMEOUT_MS,
	MAX_GATE_TIMEOUT_MS,
} from './gate-allowlist';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Context passed to gate evaluation.
 * Holds external state that non-automated gates may need to check.
 */
export interface GateContext {
	/** Absolute path to the workspace (cwd for shell-executing gates) */
	workspacePath: string;
	/**
	 * Whether a human has explicitly approved advancement.
	 * Set externally (e.g. via RPC) into run.config.humanApproved before retry.
	 */
	humanApproved?: boolean;
	/**
	 * Whether a PR review has been approved.
	 * Set externally into run.config.prApproved before retry.
	 */
	prApproved?: boolean;
}

/** Result of a single gate evaluation attempt */
export interface GateResult {
	/** Whether the gate passed */
	passed: boolean;
	/** Human-readable explanation when the gate did not pass */
	reason?: string;
}

/**
 * Error thrown by advance() when a gate fails after all retries.
 * The run's status will already be set to 'needs_attention' when this is thrown.
 */
export class WorkflowGateError extends Error {
	constructor(
		message: string,
		/** Which gate position failed: 'exit' (current step) or 'entry' (next step) */
		public readonly gatePosition: 'exit' | 'entry'
	) {
		super(message);
		this.name = 'WorkflowGateError';
	}
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Injectable command runner for quality_check and custom gates.
 * The default uses Bun.spawn; tests inject a mock to avoid real subprocess calls.
 */
export type CommandRunner = (
	args: string[],
	cwd: string,
	timeoutMs: number
) => Promise<{ exitCode: number | null; timedOut?: boolean }>;

// ---------------------------------------------------------------------------
// Shell security helpers (re-applied at execution time for defence-in-depth)
// ---------------------------------------------------------------------------

/**
 * Shell metacharacters that are never allowed in gate commands, regardless of
 * allowlist.  Mirrors the validation in SpaceWorkflowManager — we re-check at
 * execution time so that stored values cannot be exploited even if the storage
 * validation is somehow bypassed.
 */
const SHELL_METACHAR_RE = /[;&|`$<>\\\n\r]/;

function isAllowlistedCommand(command: string): boolean {
	const trimmed = command.trim();
	if (SHELL_METACHAR_RE.test(trimmed)) return false;
	const lower = trimmed.toLowerCase();
	return GATE_QUALITY_CHECK_ALLOWLIST.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

interface PathValidation {
	valid: boolean;
	reason?: string;
}

function validateCustomPath(command: string): PathValidation {
	const trimmed = command.trim();

	if (SHELL_METACHAR_RE.test(trimmed)) {
		return { valid: false, reason: 'command contains shell metacharacters or control characters' };
	}
	if (trimmed.startsWith('/')) {
		return { valid: false, reason: 'command must be a relative path, not absolute' };
	}
	const parts = trimmed.split('/');
	if (parts.some((p) => p === '..')) {
		return { valid: false, reason: "command must not contain '..' path traversal" };
	}
	if (!trimmed.startsWith('./')) {
		return { valid: false, reason: "command must start with './' (relative to workspace root)" };
	}
	return { valid: true };
}

// ---------------------------------------------------------------------------
// Default command runner (real Bun.spawn)
// ---------------------------------------------------------------------------

const defaultCommandRunner: CommandRunner = async (args, cwd, timeoutMs) => {
	const proc = Bun.spawn(args, {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});

	if (timeoutMs <= 0) {
		const exitCode = await proc.exited;
		return { exitCode };
	}

	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		proc.kill();
	}, timeoutMs);

	await proc.exited;
	clearTimeout(timer);

	if (killed) {
		return { exitCode: null, timedOut: true };
	}
	return { exitCode: proc.exitCode };
};

// ---------------------------------------------------------------------------
// WorkflowExecutor
// ---------------------------------------------------------------------------

export class WorkflowExecutor {
	constructor(
		private workflow: SpaceWorkflow,
		private run: SpaceWorkflowRun,
		private taskManager: SpaceTaskManager,
		private workflowRunRepo: SpaceWorkflowRunRepository,
		/** Reserved for future use (e.g., resolving agent config when spawning sessions) */
		private agentManager: SpaceAgentManager,
		private workspacePath: string,
		private commandRunner: CommandRunner = defaultCommandRunner
	) {}

	// -------------------------------------------------------------------------
	// Navigation
	// -------------------------------------------------------------------------

	/**
	 * Returns the step currently being executed (at run.currentStepIndex), or
	 * null if the run has advanced past all steps (i.e. the workflow is complete).
	 */
	getCurrentStep(): WorkflowStep | null {
		const sorted = this.getSortedSteps();
		return sorted[this.run.currentStepIndex] ?? null;
	}

	/**
	 * Returns the next step (at currentStepIndex + 1), or null if the current
	 * step is the last one.
	 */
	getNextStep(): WorkflowStep | null {
		const sorted = this.getSortedSteps();
		return sorted[this.run.currentStepIndex + 1] ?? null;
	}

	/**
	 * Returns true when all steps have been executed (or the run is in a
	 * terminal status that prevents further advancement).
	 */
	isComplete(): boolean {
		if (this.run.status === 'completed' || this.run.status === 'cancelled') {
			return true;
		}
		return this.run.currentStepIndex >= this.getSortedSteps().length;
	}

	// -------------------------------------------------------------------------
	// Gate checks (single evaluation, no retry)
	// -------------------------------------------------------------------------

	/**
	 * Evaluates the exit gate of the current step.
	 * Returns `{ allowed: true }` when no exit gate is defined (auto-advance).
	 */
	async canAdvance(): Promise<{ allowed: boolean; reason?: string }> {
		const step = this.getCurrentStep();
		if (!step) {
			return { allowed: false, reason: 'No current step — workflow may already be complete' };
		}
		if (!step.exitGate) return { allowed: true };

		const result = await this.evaluateGate(step.exitGate, this.getGateContext());
		return { allowed: result.passed, reason: result.reason };
	}

	/**
	 * Evaluates the entry gate of the step at `stepIndex`.
	 * Called by advance() before entering the next step, and by SpaceRuntime
	 * before starting the first step (index 0).
	 * Returns `{ allowed: true }` when no entry gate is defined.
	 */
	async canEnterStep(stepIndex: number): Promise<{ allowed: boolean; reason?: string }> {
		const sorted = this.getSortedSteps();
		const step = sorted[stepIndex];
		if (!step) {
			return { allowed: false, reason: `No step at index ${stepIndex}` };
		}
		if (!step.entryGate) return { allowed: true };

		const result = await this.evaluateGate(step.entryGate, this.getGateContext());
		return { allowed: result.passed, reason: result.reason };
	}

	// -------------------------------------------------------------------------
	// Advance
	// -------------------------------------------------------------------------

	/**
	 * Advances the workflow run to the next step.
	 *
	 * Flow:
	 *   1. Evaluate exit gate of current step (with retry up to gate.maxRetries)
	 *   2. Evaluate entry gate of the next step (with retry)
	 *   3. Persist the new currentStepIndex on SpaceWorkflowRun
	 *   4. Create SpaceTask DB records (pending status) for the next step
	 *
	 * When the current step is the last step and the exit gate passes, the run is
	 * marked as 'completed' and an empty tasks array is returned.
	 *
	 * If a gate fails after all retries the run status is set to 'needs_attention'
	 * and a WorkflowGateError is thrown.
	 *
	 * Does NOT spawn session groups — that is SpaceRuntime's responsibility.
	 */
	async advance(): Promise<{ step: WorkflowStep; tasks: SpaceTask[] }> {
		if (this.isComplete()) {
			throw new Error('Cannot advance: workflow run is already complete');
		}

		const current = this.getCurrentStep();
		if (!current) {
			throw new Error('Cannot advance: no current step');
		}

		// --- 1. Evaluate exit gate of current step ---
		if (current.exitGate) {
			const exitResult = await this.evaluateGateWithRetry(current.exitGate, this.getGateContext());
			if (!exitResult.passed) {
				await this.markNeedsAttention();
				throw new WorkflowGateError(
					`Exit gate failed for step "${current.name}": ${exitResult.reason ?? 'gate evaluation failed'}`,
					'exit'
				);
			}
		}

		const nextIndex = this.run.currentStepIndex + 1;
		const sorted = this.getSortedSteps();
		const next = sorted[nextIndex];

		// --- No next step → mark run completed ---
		if (!next) {
			const updated = this.workflowRunRepo.updateRun(this.run.id, {
				currentStepIndex: nextIndex,
				status: 'completed',
			});
			if (updated) this.run = updated;
			return { step: current, tasks: [] };
		}

		// --- 2. Evaluate entry gate of next step ---
		if (next.entryGate) {
			const entryResult = await this.evaluateGateWithRetry(next.entryGate, this.getGateContext());
			if (!entryResult.passed) {
				await this.markNeedsAttention();
				throw new WorkflowGateError(
					`Entry gate failed for step "${next.name}": ${entryResult.reason ?? 'gate evaluation failed'}`,
					'entry'
				);
			}
		}

		// --- 3. Persist new step index ---
		const updatedRun = this.workflowRunRepo.updateStepIndex(this.run.id, nextIndex);
		if (!updatedRun) throw new Error('Failed to persist step index update');
		this.run = updatedRun;

		// --- 4. Create SpaceTask records for next step ---
		const task = await this.taskManager.createTask({
			title: next.name,
			description: next.instructions ?? '',
			workflowRunId: this.run.id,
			workflowStepId: next.id,
			customAgentId: next.agentId,
			status: 'pending',
		});

		return { step: next, tasks: [task] };
	}

	// -------------------------------------------------------------------------
	// Gate evaluation (public — callable by SpaceRuntime for one-off checks)
	// -------------------------------------------------------------------------

	/**
	 * Evaluates a single gate against the given context.
	 * Does NOT apply retries — call evaluateGateWithRetry for retry semantics.
	 *
	 * Gate types:
	 *   auto           — always passes
	 *   human_approval — passes when context.humanApproved is true
	 *   quality_check  — runs an allowlisted command; passes on exit code 0
	 *   pr_review      — passes when context.prApproved is true
	 *   custom         — runs a validated relative-path script; passes on exit code 0
	 */
	async evaluateGate(gate: WorkflowGate, context: GateContext): Promise<GateResult> {
		switch (gate.type) {
			case 'auto':
				return { passed: true };

			case 'human_approval':
				if (context.humanApproved) {
					return { passed: true };
				}
				return { passed: false, reason: 'Waiting for human approval' };

			case 'pr_review':
				if (context.prApproved) {
					return { passed: true };
				}
				return { passed: false, reason: 'Waiting for PR review approval' };

			case 'quality_check':
				return this.runQualityCheck(gate, context);

			case 'custom':
				return this.runCustomScript(gate, context);

			default: {
				const _exhaustive: never = gate.type;
				return { passed: false, reason: `Unknown gate type: ${_exhaustive}` };
			}
		}
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/** Returns steps sorted ascending by their order field. */
	private getSortedSteps(): WorkflowStep[] {
		return [...this.workflow.steps].sort((a, b) => a.order - b.order);
	}

	/** Builds a GateContext from the current run's config and workspacePath. */
	private getGateContext(): GateContext {
		const config = (this.run.config ?? {}) as Record<string, unknown>;
		return {
			workspacePath: this.workspacePath,
			humanApproved: config.humanApproved === true,
			prApproved: config.prApproved === true,
		};
	}

	/** Evaluates a gate with retry semantics as specified by gate.maxRetries. */
	private async evaluateGateWithRetry(
		gate: WorkflowGate,
		context: GateContext
	): Promise<GateResult> {
		const maxAttempts = 1 + (gate.maxRetries ?? 0);
		let lastResult: GateResult = { passed: false, reason: 'Gate never evaluated' };

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			lastResult = await this.evaluateGate(gate, context);
			if (lastResult.passed) return lastResult;
		}

		return lastResult;
	}

	/** Sets run status to needs_attention and syncs this.run. */
	private async markNeedsAttention(): Promise<void> {
		const updated = this.workflowRunRepo.updateStatus(this.run.id, 'needs_attention');
		if (updated) this.run = updated;
	}

	/** Executes a quality_check gate command. */
	private async runQualityCheck(gate: WorkflowGate, context: GateContext): Promise<GateResult> {
		if (!gate.command || !gate.command.trim()) {
			return { passed: false, reason: 'quality_check gate has no command' };
		}

		// Security: re-validate at execution time
		if (!isAllowlistedCommand(gate.command)) {
			return {
				passed: false,
				reason: `Command "${gate.command}" is not in the quality_check allowlist`,
			};
		}

		return this.spawnGateCommand(gate.command, context.workspacePath, gate.timeoutMs);
	}

	/** Executes a custom gate script. */
	private async runCustomScript(gate: WorkflowGate, context: GateContext): Promise<GateResult> {
		if (!gate.command || !gate.command.trim()) {
			return { passed: false, reason: 'custom gate has no command' };
		}

		// Security: re-validate path at execution time
		const pathCheck = validateCustomPath(gate.command);
		if (!pathCheck.valid) {
			return { passed: false, reason: `Invalid custom gate command: ${pathCheck.reason}` };
		}

		return this.spawnGateCommand(gate.command, context.workspacePath, gate.timeoutMs);
	}

	/**
	 * Spawns a gate command and returns whether it exited with code 0.
	 * Enforces timeout (default 60 s, max 300 s).
	 */
	private async spawnGateCommand(
		command: string,
		cwd: string,
		timeoutMs?: number
	): Promise<GateResult> {
		const effectiveTimeout = resolveTimeout(timeoutMs);
		const args = command.trim().split(/\s+/);

		let result: { exitCode: number | null; timedOut?: boolean };
		try {
			result = await this.commandRunner(args, cwd, effectiveTimeout);
		} catch (err) {
			return {
				passed: false,
				reason: `Command execution error: ${(err as Error).message}`,
			};
		}

		if (result.timedOut) {
			return { passed: false, reason: `Gate command timed out after ${effectiveTimeout}ms` };
		}

		if (result.exitCode !== 0) {
			return {
				passed: false,
				reason: `Command exited with code ${result.exitCode ?? 'null'}`,
			};
		}

		return { passed: true };
	}
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Clamps/resolves the gate timeout to the valid range. */
function resolveTimeout(timeoutMs?: number): number {
	if (!timeoutMs || timeoutMs <= 0) return DEFAULT_GATE_TIMEOUT_MS;
	return Math.min(timeoutMs, MAX_GATE_TIMEOUT_MS);
}
