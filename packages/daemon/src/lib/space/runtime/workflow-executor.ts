/**
 * WorkflowExecutor
 *
 * Manages workflow run progression within a Space using a directed graph model.
 * Steps are nodes; transitions are edges with optional conditions.
 *
 * Responsibilities:
 * - Graph navigation (getCurrentStep, getOutgoingTransitions, isComplete)
 * - Condition evaluation for transitions (always, human, condition)
 * - Timeout enforcement on condition-type transitions
 * - Retry logic: re-evaluate condition only (NOT re-run agent)
 * - Persisting currentStepId on SpaceWorkflowRun after advance
 * - Creating SpaceTask DB records (pending only) — does NOT spawn sessions
 *
 * advance() evaluates outgoing transitions from the current step in ascending
 * order and follows the first one whose condition passes. A step with no
 * outgoing transitions is terminal — calling advance() on it marks the run
 * as 'completed' and returns the terminal step with an empty tasks list.
 */

import type {
	SpaceWorkflow,
	SpaceWorkflowRun,
	SpaceTask,
	WorkflowCondition,
	WorkflowTransition,
	WorkflowStep,
} from '@neokai/shared';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskManager } from '../managers/space-task-manager';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Context passed to condition evaluation.
 */
export interface ConditionContext {
	/** Absolute path to the workspace (cwd for condition-type expressions) */
	workspacePath: string;
	/**
	 * Whether a human has explicitly approved advancement.
	 * Set externally (e.g. via RPC) into run.config.humanApproved before retry.
	 */
	humanApproved?: boolean;
}

/** Result of a single condition evaluation attempt */
export interface ConditionResult {
	/** Whether the condition passed */
	passed: boolean;
	/** Human-readable explanation when the condition did not pass */
	reason?: string;
}

/**
 * Error thrown by advance() when all outgoing transition conditions fail after retries.
 * The run's status will already be set to 'needs_attention' when this is thrown.
 */
export class WorkflowTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkflowTransitionError';
	}
}

/**
 * Error thrown by advance() when a human-gate transition blocks advancement.
 * Indicates that the run is paused waiting for explicit human approval.
 * The SpaceRuntime catches this and keeps the executor in the map for retry
 * once the gate is resolved.
 */
export class WorkflowGateError extends WorkflowTransitionError {
	constructor(message: string) {
		super(message);
		this.name = 'WorkflowGateError';
	}
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Injectable command runner for condition-type transitions.
 * The default uses Bun.spawn; tests inject a mock to avoid real subprocess calls.
 */
export type CommandRunner = (
	args: string[],
	cwd: string,
	timeoutMs: number
) => Promise<{ exitCode: number | null; timedOut?: boolean; stderr?: string }>;

/**
 * Optional resolver injected by SpaceRuntime to set task metadata (taskType,
 * customAgentId) at task-creation time. When provided, the task is created
 * complete in a single DB write — no second update required.
 */
export type TaskTypeResolver = (step: WorkflowStep) => {
	taskType?: string;
	customAgentId?: string;
};

// ---------------------------------------------------------------------------
// Default timeout constants
// ---------------------------------------------------------------------------

const DEFAULT_CONDITION_TIMEOUT_MS = 60_000;
const MAX_CONDITION_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Default command runner (real Bun.spawn)
// ---------------------------------------------------------------------------

const defaultCommandRunner: CommandRunner = async (args, cwd, timeoutMs) => {
	const proc = Bun.spawn(args, {
		cwd,
		// stdout is ignored — only the exit code matters for condition evaluation.
		// stderr is piped so we can capture it for failure diagnostics.
		// IMPORTANT: drain stderr concurrently with proc.exited to prevent pipe deadlock
		// when the process writes more than ~64KB to stderr.
		stdout: 'ignore',
		stderr: 'pipe',
	});

	let killed = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;

	if (timeoutMs > 0) {
		killTimer = setTimeout(() => {
			killed = true;
			proc.kill();
		}, timeoutMs);
	}

	const [stderr] = await Promise.all([
		new Response(proc.stderr).text().catch(() => ''),
		proc.exited,
	]);

	if (killTimer !== undefined) clearTimeout(killTimer);

	if (killed) {
		return { exitCode: null, timedOut: true, stderr };
	}
	return { exitCode: proc.exitCode, stderr };
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
		private workspacePath: string,
		private commandRunner: CommandRunner = defaultCommandRunner,
		private taskTypeResolver?: TaskTypeResolver
	) {}

	// -------------------------------------------------------------------------
	// Navigation
	// -------------------------------------------------------------------------

	/**
	 * Returns the step currently being executed, or null if the run has completed
	 * or been cancelled.
	 */
	getCurrentStep(): WorkflowStep | null {
		if (this.run.status === 'completed' || this.run.status === 'cancelled') {
			return null;
		}
		return this.workflow.steps.find((s) => s.id === this.run.currentStepId) ?? null;
	}

	/**
	 * Returns all outgoing transitions from the current step, sorted ascending by order.
	 */
	getOutgoingTransitions(): WorkflowTransition[] {
		return this.workflow.transitions
			.filter((t) => t.from === this.run.currentStepId)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	}

	/**
	 * Returns true when the run has reached a terminal state.
	 * A run becomes terminal when:
	 * - status is 'completed' or 'cancelled' (set by advance() or external cancellation)
	 */
	isComplete(): boolean {
		return this.run.status === 'completed' || this.run.status === 'cancelled';
	}

	// -------------------------------------------------------------------------
	// Condition checks (single evaluation, no retry)
	// -------------------------------------------------------------------------

	/**
	 * Evaluates a single condition against the given context.
	 * Does NOT apply retries — call evaluateConditionWithRetry for retry semantics.
	 *
	 * Condition types:
	 *   always    — always passes
	 *   human     — passes when context.humanApproved is true
	 *   condition — runs the expression as a shell command; passes on exit code 0
	 */
	async evaluateCondition(
		condition: WorkflowCondition,
		context: ConditionContext
	): Promise<ConditionResult> {
		switch (condition.type) {
			case 'always':
				return { passed: true };

			case 'human':
				if (context.humanApproved) {
					return { passed: true };
				}
				return { passed: false, reason: 'Waiting for human approval' };

			case 'condition': {
				if (!condition.expression || !condition.expression.trim()) {
					return { passed: false, reason: 'condition type requires a non-empty expression' };
				}
				return this.runConditionExpression(
					condition.expression,
					context.workspacePath,
					condition.timeoutMs
				);
			}

			default: {
				const _exhaustive: never = condition.type;
				return { passed: false, reason: `Unknown condition type: ${_exhaustive}` };
			}
		}
	}

	// -------------------------------------------------------------------------
	// Advance
	// -------------------------------------------------------------------------

	/**
	 * Advances the workflow run along a matching outgoing transition.
	 *
	 * Flow:
	 *   1. Guard: throw if run is complete or needs_attention
	 *   2. Get outgoing transitions from current step (sorted by order)
	 *   3. If no transitions → mark run completed, return { step: current, tasks: [] }
	 *   4. Evaluate each transition's condition (with retry) until one passes
	 *   5. Persist currentStepId pointing to the transition's target step
	 *   6. Create a pending SpaceTask for the target step
	 *
	 * If no transition's condition passes, the run is set to 'needs_attention'
	 * and a WorkflowTransitionError is thrown.
	 *
	 * Does NOT spawn session groups — that is SpaceRuntime's responsibility.
	 */
	async advance(): Promise<{ step: WorkflowStep; tasks: SpaceTask[] }> {
		if (this.isComplete()) {
			throw new Error('Cannot advance: workflow run is already complete');
		}

		// A condition failure sets status to needs_attention; require explicit external
		// reset (e.g. updating run.config with the approval flag) before retrying.
		if (this.run.status === 'needs_attention') {
			throw new Error(
				'Cannot advance: run status is needs_attention — resolve the condition failure and reset status before retrying'
			);
		}

		const current = this.getCurrentStep();
		if (!current) {
			throw new Error('Cannot advance: no current step');
		}

		const transitions = this.getOutgoingTransitions();

		// No outgoing transitions → terminal step → mark run completed
		if (transitions.length === 0) {
			const updated = this.workflowRunRepo.updateRun(this.run.id, { status: 'completed' });
			if (updated) this.run = updated;
			return { step: current, tasks: [] };
		}

		// Evaluate transitions in order; follow the first one whose condition passes.
		// A failing condition does NOT stop evaluation — the next transition is tried.
		// Only when every transition has been evaluated and none passed is the run marked
		// needs_attention and a WorkflowTransitionError thrown.
		const context = this.getConditionContext();
		let lastReason: string | undefined;
		let blockedByHumanGate = false;

		for (const transition of transitions) {
			const condition = transition.condition;

			// No condition or 'always' → unconditionally follow this transition
			if (!condition || condition.type === 'always') {
				return this.followTransition(transition);
			}

			const result = await this.evaluateConditionWithRetry(condition, context);
			if (result.passed) {
				const advanced = await this.followTransition(transition);
				// Clear humanApproved after consuming a human transition to prevent stale re-use
				// in cycles: the next time a human transition is reached the user must
				// explicitly approve again.
				if (condition.type === 'human') {
					this.clearHumanApproval();
				}
				return advanced;
			}

			lastReason = result.reason;
			if (condition.type === 'human') {
				blockedByHumanGate = true;
			}
			// Condition did not pass — continue to next transition
		}

		// All transitions evaluated; none passed → needs_attention
		this.markNeedsAttention();
		const gateMessage = `No matching transition from step "${current.name}": ${lastReason ?? 'no condition passed'}`;
		if (blockedByHumanGate) {
			throw new WorkflowGateError(gateMessage);
		}
		throw new WorkflowTransitionError(gateMessage);
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/** Builds a ConditionContext from the current run's config and workspacePath. */
	private getConditionContext(): ConditionContext {
		const config = (this.run.config ?? {}) as Record<string, unknown>;
		return {
			workspacePath: this.workspacePath,
			humanApproved: config.humanApproved === true,
		};
	}

	/** Follows a transition: updates currentStepId and creates a SpaceTask for the target step. */
	private async followTransition(
		transition: WorkflowTransition
	): Promise<{ step: WorkflowStep; tasks: SpaceTask[] }> {
		const nextStep = this.workflow.steps.find((s) => s.id === transition.to);
		if (!nextStep) {
			throw new Error(`Target step "${transition.to}" not found in workflow "${this.workflow.id}"`);
		}

		// Persist new currentStepId
		const updatedRun = this.workflowRunRepo.updateCurrentStep(this.run.id, nextStep.id);
		if (!updatedRun) throw new Error('Failed to persist step ID update');
		this.run = updatedRun;

		// Resolve task metadata so the task is created complete in a single write.
		// When a taskTypeResolver is provided it fully controls taskType AND customAgentId —
		// customAgentId: undefined means "no custom agent" for preset roles (planner/coder/general).
		// Without a resolver (backward-compat), fall back to nextStep.agentId.
		const resolved = this.taskTypeResolver?.(nextStep);

		// Create a pending SpaceTask for the new step
		const task = await this.taskManager.createTask({
			title: nextStep.name,
			description: nextStep.instructions ?? '',
			workflowRunId: this.run.id,
			workflowStepId: nextStep.id,
			taskType: resolved?.taskType as import('@neokai/shared').SpaceTaskType | undefined,
			customAgentId: resolved !== undefined ? resolved.customAgentId : nextStep.agentId,
			status: 'pending',
			goalId: this.run.goalId,
		});

		return { step: nextStep, tasks: [task] };
	}

	/**
	 * Evaluates a condition with retry semantics as specified by condition.maxRetries.
	 *
	 * Note: for `human` conditions, the context is captured once before the retry loop
	 * and `humanApproved` cannot change between retries within a single advance() call.
	 * `maxRetries` has no practical effect for `human` conditions — they are short-circuited
	 * after the first evaluation.
	 */
	private async evaluateConditionWithRetry(
		condition: WorkflowCondition,
		context: ConditionContext
	): Promise<ConditionResult> {
		// human conditions cannot change between retries in the same advance() call;
		// short-circuit after the first evaluation to avoid redundant checks.
		const maxAttempts = condition.type === 'human' ? 1 : 1 + (condition.maxRetries ?? 0);
		let lastResult: ConditionResult = { passed: false, reason: 'Condition never evaluated' };

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			lastResult = await this.evaluateCondition(condition, context);
			if (lastResult.passed) return lastResult;
		}

		return lastResult;
	}

	/** Sets run status to needs_attention and syncs this.run. */
	private markNeedsAttention(): void {
		const updated = this.workflowRunRepo.updateStatus(this.run.id, 'needs_attention');
		if (updated) this.run = updated;
	}

	/**
	 * Clears the humanApproved flag from run.config after it has been consumed.
	 * This prevents a stale approval from auto-passing subsequent human transitions in cycles.
	 */
	private clearHumanApproval(): void {
		const config = (this.run.config ?? {}) as Record<string, unknown>;
		if (config.humanApproved !== undefined) {
			const rest = { ...config };
			delete rest.humanApproved;
			const updated = this.workflowRunRepo.updateRun(this.run.id, { config: rest });
			if (updated) this.run = updated;
		}
	}

	/**
	 * Executes a condition expression via the shell and returns whether it exited with code 0.
	 *
	 * The expression is passed to `sh -c` so that shell semantics (quoting, pipes,
	 * redirects, arguments with spaces) work as expected.
	 */
	private async runConditionExpression(
		expression: string,
		cwd: string,
		timeoutMs?: number
	): Promise<ConditionResult> {
		const effectiveTimeout = resolveTimeout(timeoutMs);
		const args = ['sh', '-c', expression.trim()];

		let result: { exitCode: number | null; timedOut?: boolean; stderr?: string };
		try {
			result = await this.commandRunner(args, cwd, effectiveTimeout);
		} catch (err) {
			return {
				passed: false,
				reason: `Expression execution error: ${(err as Error).message}`,
			};
		}

		if (result.timedOut) {
			return { passed: false, reason: `Expression timed out after ${effectiveTimeout}ms` };
		}

		if (result.exitCode !== 0) {
			const stderrSnippet = result.stderr?.trim() ? `: ${result.stderr.slice(-500).trim()}` : '';
			return {
				passed: false,
				reason: `Expression exited with code ${result.exitCode ?? 'null'}${stderrSnippet}`,
			};
		}

		return { passed: true };
	}
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Clamps/resolves the condition timeout to the valid range. */
function resolveTimeout(timeoutMs?: number): number {
	if (!timeoutMs || timeoutMs <= 0) return DEFAULT_CONDITION_TIMEOUT_MS;
	return Math.min(timeoutMs, MAX_CONDITION_TIMEOUT_MS);
}
