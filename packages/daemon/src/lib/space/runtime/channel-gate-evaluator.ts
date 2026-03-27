/**
 * ChannelGateEvaluator
 *
 * Evaluates whether a WorkflowChannel's gate condition allows message delivery.
 *
 * Gate types supported:
 *   always      — channel is always open; delivery is never blocked
 *   human       — delivery requires explicit human approval (context.humanApproved === true)
 *   condition   — shell expression; delivery allowed when expression exits with code 0
 *   task_result — delivery allowed when context.taskResult starts with gate.expression
 *
 * Usage:
 *   const evaluator = new ChannelGateEvaluator(workspacePath);
 *   const result = await evaluator.evaluate(channel, { humanApproved: false });
 *   if (!result.allowed) throw new ChannelGateBlockedError(result.reason!);
 */

import type { WorkflowChannel, WorkflowCondition } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Context provided to gate evaluation.
 * Callers populate only the fields relevant to the gate type being evaluated.
 */
export interface ChannelGateContext {
	/** Absolute path to the workspace root (cwd for `condition`-type shell expressions). */
	workspacePath: string;
	/**
	 * Whether a human has explicitly approved delivery on this channel.
	 * Required for `human` gate type — delivery is blocked until this is true.
	 */
	humanApproved?: boolean;
	/**
	 * Task result string for `task_result` gate type.
	 * Delivery is allowed when this value starts with `gate.expression`.
	 */
	taskResult?: string;
}

/** Result of a single gate evaluation attempt. */
export interface GateResult {
	/** Whether delivery is allowed. */
	allowed: boolean;
	/** Human-readable explanation when delivery is blocked. */
	reason?: string;
}

/**
 * Thrown by evaluate() when the gate condition blocks message delivery.
 * Callers may catch this to provide user-visible feedback or to queue the message.
 */
export class ChannelGateBlockedError extends Error {
	constructor(
		message: string,
		/**
		 * The gate type that caused the block (for programmatic handling).
		 * For legacy WorkflowChannel gates: one of 'always' | 'human' | 'condition' | 'task_result'.
		 * For new Gate entities: one of 'check' | 'count' | 'all' | 'any', or a gate ID string.
		 */
		public readonly gateType: string
	) {
		super(message);
		this.name = 'ChannelGateBlockedError';
	}
}

/**
 * Injectable command runner — the default uses Bun.spawn; tests inject a mock.
 * Signature mirrors CommandRunner in workflow-executor.ts.
 */
export type ChannelCommandRunner = (
	args: string[],
	cwd: string,
	timeoutMs: number
) => Promise<{ exitCode: number | null; timedOut?: boolean; stderr?: string }>;

// ---------------------------------------------------------------------------
// Default timeout constants (matches WorkflowExecutor values)
// ---------------------------------------------------------------------------

const DEFAULT_CONDITION_TIMEOUT_MS = 60_000;
const MAX_CONDITION_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Default command runner (real Bun.spawn)
// ---------------------------------------------------------------------------

const defaultCommandRunner: ChannelCommandRunner = async (args, cwd, timeoutMs) => {
	const proc = Bun.spawn(args, {
		cwd,
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
// ChannelGateEvaluator
// ---------------------------------------------------------------------------

export class ChannelGateEvaluator {
	constructor(private readonly commandRunner: ChannelCommandRunner = defaultCommandRunner) {}

	/**
	 * Evaluates whether the channel's gate allows message delivery.
	 *
	 * - If the channel has no `gate` field, delivery is always allowed.
	 * - If the gate type is `always`, delivery is always allowed.
	 * - Otherwise, returns `{ allowed: false, reason }` when the gate blocks.
	 *
	 * Does NOT throw on blocked gates — callers may throw ChannelGateBlockedError
	 * themselves when appropriate. This keeps the evaluator pure and composable.
	 */
	async evaluate(channel: WorkflowChannel, context: ChannelGateContext): Promise<GateResult> {
		if (!channel.gate) {
			return { allowed: true };
		}
		return this.evaluateCondition(channel.gate, context);
	}

	/**
	 * Evaluates a single WorkflowCondition against the given context.
	 *
	 * Exposed as a public method so callers can evaluate conditions outside of a
	 * channel (e.g. for testing individual gate expressions in isolation).
	 */
	async evaluateCondition(
		condition: WorkflowCondition,
		context: ChannelGateContext
	): Promise<GateResult> {
		switch (condition.type) {
			case 'always':
				return { allowed: true };

			case 'human':
				if (context.humanApproved) {
					return { allowed: true };
				}
				return {
					allowed: false,
					reason: 'Gate blocked: waiting for human approval before message delivery',
				};

			case 'condition': {
				if (!condition.expression || !condition.expression.trim()) {
					return {
						allowed: false,
						reason: 'Gate blocked: condition gate requires a non-empty expression',
					};
				}
				return this.runConditionExpression(
					condition.expression,
					context.workspacePath,
					condition.timeoutMs
				);
			}

			case 'task_result': {
				if (!condition.expression || !condition.expression.trim()) {
					return {
						allowed: false,
						reason: 'Gate blocked: task_result gate requires a non-empty expression',
					};
				}
				if (context.taskResult === undefined) {
					return {
						allowed: false,
						reason: 'Gate blocked: no task result available for task_result gate evaluation',
					};
				}
				if (context.taskResult.startsWith(condition.expression)) {
					return { allowed: true };
				}
				return {
					allowed: false,
					reason: `Gate blocked: task result "${context.taskResult}" does not match expected "${condition.expression}"`,
				};
			}

			default: {
				const _exhaustive: never = condition.type;
				return {
					allowed: false,
					reason: `Gate blocked: unknown gate type "${_exhaustive}"`,
				};
			}
		}
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/**
	 * Executes a condition expression via the shell and returns whether it exited with code 0.
	 * The expression is passed to `sh -c` so shell semantics work as expected.
	 */
	private async runConditionExpression(
		expression: string,
		cwd: string,
		timeoutMs?: number
	): Promise<GateResult> {
		const effectiveTimeout = resolveTimeout(timeoutMs);
		const args = ['sh', '-c', expression.trim()];

		let result: { exitCode: number | null; timedOut?: boolean; stderr?: string };
		try {
			result = await this.commandRunner(args, cwd, effectiveTimeout);
		} catch (err) {
			return {
				allowed: false,
				reason: `Gate blocked: expression execution error: ${(err as Error).message}`,
			};
		}

		if (result.timedOut) {
			return {
				allowed: false,
				reason: `Gate blocked: condition expression timed out after ${effectiveTimeout}ms`,
			};
		}

		if (result.exitCode !== 0) {
			const stderrSnippet = result.stderr?.trim() ? `: ${result.stderr.slice(-500).trim()}` : '';
			return {
				allowed: false,
				reason: `Gate blocked: condition expression exited with code ${result.exitCode ?? 'null'}${stderrSnippet}`,
			};
		}

		return { allowed: true };
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
