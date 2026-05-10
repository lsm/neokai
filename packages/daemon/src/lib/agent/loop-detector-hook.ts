/**
 * Loop Detector Hook
 *
 * Detects and recovers from "dead loops" where the agent calls the same
 * idempotent inspection tool (Read / Grep / Glob) repeatedly with identical
 * arguments without making any forward progress.
 *
 * Real-world trigger (task #324, see task #328): the coder agent called
 * `Read` on `client-event-bridge.ts` ~60 times in a single turn before the
 * user intervened. The file content was unchanged across every read; the
 * agent had entered a degenerate planning state.
 *
 * Strategy: a `PreToolUse` hook keeps a per-agent ledger of the *current
 * consecutive streak* — i.e. successive invocations of the same
 * `(tool_name, args)` key with no intervening different tool call. The hook
 * is registered for ALL tools (not just tracked ones) so that any other
 * action — running a Bash command, editing a file, even calling a
 * non-tracked inspection tool — counts as a "different action" and resets
 * the streak. Once the streak crosses a per-tool threshold within a sliding
 * window (computed over the *full* streak duration, not just the gap to the
 * previous call), the hook denies the call with a `permissionDecisionReason`
 * that the SDK delivers back to the model as the tool result. The reason
 * text instructs the model to stop re-running the tool and proceed to the
 * next step (e.g. its TodoWrite list).
 *
 * Bash is intentionally NOT tracked for *deny* decisions — bash output can
 * legitimately change across calls (e.g. polling `git status`, tailing logs)
 * and false positives here would be far worse than the rare degenerate loop.
 * The hook still observes Bash so it can use it as a streak-reset signal.
 * Read / Grep / Glob are pure functions of the file system at a point in
 * time, so two identical invocations seconds apart almost never produce
 * different output.
 *
 * Scoping: streaks are tracked per `(session_id, agent_id)` pair, so parallel
 * subagents under the same parent session cannot contribute to each other's
 * counters and a subagent's reads do not pollute the main thread's streak.
 *
 * Repeat denies: when a stuck agent keeps hammering the same call after a
 * deny, the streak does NOT reset on a deny — every retry without an
 * intervening different action continues to deny. This is intentional: the
 * goal is to break the loop, not just throttle it. The streak resets when
 * the agent performs a *different* tool call (tracked OR untracked) or the
 * sliding window elapses over the streak's lifetime.
 */

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { resolve as resolvePath } from 'node:path';
import { Logger } from '../logger';

/**
 * Per-tool detection thresholds and overall hook configuration.
 *
 * `thresholds[toolName]` is the consecutive-streak length at which we
 * trigger. A tool absent from `thresholds` is NEVER tracked (passes
 * through). Callers that pass a partial config — e.g. `{ thresholds: {
 * Read: 2 } }` — REPLACE the tracked-tool set; defaults are not merged in.
 * Pass `undefined` (or omit `thresholds`) to inherit
 * `DEFAULT_LOOP_DETECTOR_CONFIG.thresholds` wholesale.
 */
export interface LoopDetectorConfig {
	enabled: boolean;
	/** Sliding window in milliseconds; entries older than this are forgotten. */
	windowMs: number;
	/**
	 * Per-tool consecutive-streak threshold. Tools omitted here are not
	 * tracked. Pass `undefined` to inherit the defaults wholesale.
	 */
	thresholds?: Record<string, number>;
}

export const DEFAULT_LOOP_DETECTOR_CONFIG: Required<LoopDetectorConfig> = {
	enabled: true,
	windowMs: 60_000,
	thresholds: {
		// Read identity is strong: the SDK already surfaces "File unchanged
		// since last read", so 3 consecutive identical reads is unambiguous.
		Read: 3,
		// Grep / Glob are slightly noisier (developers genuinely re-run them
		// while exploring), so we set a more permissive threshold.
		Grep: 5,
		Glob: 5,
	},
};

interface LedgerEntry {
	/** Current consecutive-streak count for this key. */
	count: number;
	/** When this streak started (ms). Used to enforce the sliding window
	 * over the full streak duration: if `now - firstSeenMs > windowMs`,
	 * the streak is treated as expired and the next identical call
	 * starts a new streak from 1. */
	firstSeenMs: number;
	/** Most recent invocation time for this key (ms). Used for ledger
	 * eviction, not for streak-window enforcement. */
	lastSeenMs: number;
}

/**
 * Per-(session, agent) state: the last tracked key invoked, plus the streak
 * counter for that key. We only need to remember one entry per (session,
 * agent) because a different-key call resets the streak.
 */
interface AgentState {
	lastKey: string;
	entry: LedgerEntry;
}

/**
 * Stable JSON stringification: sorts object keys so `{a:1,b:2}` and
 * `{b:2,a:1}` collide in the ledger.
 */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Normalise tool input into a stable key used to detect duplicates.
 *
 * - Read: resolve `file_path` against `cwd` so `./foo` and `foo` collide;
 *   keep `offset`/`limit` as identity (different ranges should not collide).
 * - Grep / Glob: pass through, sorted via stableStringify.
 *
 * The `description` field (Bash/etc) is irrelevant to identity but Bash is
 * not tracked anyway so we don't bother stripping it generically.
 */
function buildArgKey(toolName: string, input: Record<string, unknown>, cwd?: string): string {
	if (toolName === 'Read' && typeof input.file_path === 'string') {
		const normalisedPath = cwd ? resolvePath(cwd, input.file_path) : input.file_path;
		const normalised = { ...input, file_path: normalisedPath };
		return stableStringify(normalised);
	}
	return stableStringify(input);
}

/**
 * A short human-readable summary of the duplicate args, for the recovery
 * message. Truncated to keep the model-facing message tight.
 */
function summariseArgs(toolName: string, input: Record<string, unknown>): string {
	const candidates: string[] = [];
	if (typeof input.file_path === 'string') candidates.push(`file_path=${input.file_path}`);
	if (typeof input.pattern === 'string') candidates.push(`pattern=${input.pattern}`);
	if (typeof input.path === 'string' && toolName !== 'Read') {
		candidates.push(`path=${input.path}`);
	}
	if (typeof input.glob === 'string') candidates.push(`glob=${input.glob}`);
	if (candidates.length === 0) return JSON.stringify(input).slice(0, 120);
	return candidates.join(', ').slice(0, 200);
}

function buildRecoveryMessage(toolName: string, count: number, argSummary: string): string {
	return [
		`Loop detected: ${toolName} was called ${count} times in a row with identical arguments (${argSummary}).`,
		'The result has not changed since the previous call. STOP re-running this tool — move on to the next step in your task.',
		'If you have a TodoWrite list, mark progress and proceed to the next item.',
		'If you genuinely need fresh data, perform a *different* action (edit a file, run a command, ask a question) before retrying.',
	].join(' ');
}

/**
 * Create a PreToolUse hook that detects dead loops and short-circuits them.
 *
 * The `config` parameter is reserved for testing and override use. Production
 * callers (see `QueryOptionsBuilder.buildHooks`) instantiate the hook with no
 * arguments so the defaults in `DEFAULT_LOOP_DETECTOR_CONFIG` apply.
 *
 * Threshold overrides REPLACE the tracked-tool set: e.g. passing
 * `{ thresholds: { Read: 2 } }` tracks only Read at 2, and Grep/Glob are no
 * longer tracked. Omit `thresholds` (or pass `undefined`) to inherit the
 * defaults wholesale.
 *
 * @example
 * ```ts
 * const hook = createLoopDetectorHook();
 * options.hooks = { PreToolUse: [{ hooks: [hook] }] };
 * ```
 */
export function createLoopDetectorHook(config: Partial<LoopDetectorConfig> = {}): HookCallback {
	const finalConfig: Required<LoopDetectorConfig> = {
		enabled: config.enabled ?? DEFAULT_LOOP_DETECTOR_CONFIG.enabled,
		windowMs: config.windowMs ?? DEFAULT_LOOP_DETECTOR_CONFIG.windowMs,
		// REPLACE — do not merge. A caller passing { Read: 2 } means "track
		// only Read." This is what the contract on LoopDetectorConfig
		// promises. Pass undefined / omit to keep the defaults wholesale.
		thresholds: config.thresholds ?? DEFAULT_LOOP_DETECTOR_CONFIG.thresholds,
	};
	const logger = new Logger('LoopDetectorHook');
	// One ledger per (session_id, agent_id). Each subagent gets its own
	// streak; the main thread's streak is also isolated from any subagents
	// it spawns.
	const ledger = new Map<string, AgentState>();

	return async (input, _toolUseID, { signal: _signal }) => {
		if (!finalConfig.enabled) return {};
		if (input.hook_event_name !== 'PreToolUse') return {};

		const preInput = input as PreToolUseHookInput;
		const { tool_name, tool_input, cwd, session_id, agent_id } = preInput;

		const scope = `${session_id}::${agent_id ?? 'main'}`;
		const threshold = finalConfig.thresholds[tool_name];
		const now = Date.now();

		// Untracked tool (Bash, Edit, Write, …) is treated as a *different
		// action*: it resets any in-flight streak for this scope so that a
		// genuine corrective step (e.g. `Edit foo.ts` after a denied
		// `Read foo.ts`) lets the next identical Read pass through. We
		// then short-circuit — there is nothing to deny on an untracked
		// tool.
		if (typeof threshold !== 'number') {
			ledger.delete(scope);
			return {};
		}

		const args = (tool_input ?? {}) as Record<string, unknown>;
		const key = `${tool_name}:${buildArgKey(tool_name, args, cwd)}`;

		const state = ledger.get(scope);
		const sameKey = state?.lastKey === key;
		// Sliding window is enforced over the *full streak duration*, not
		// just the gap between successive calls. A sequence at t=0,59s,118s
		// with a 60s window has duration 118s > 60s on the third call, so
		// the streak resets to 1 — matching "N repeats within window"
		// semantics rather than "max inter-call gap".
		const withinWindow = state && now - state.entry.firstSeenMs <= finalConfig.windowMs;

		// Strict consecutive semantics: streak only continues when the same
		// key is invoked AND the *whole* streak still fits in the sliding
		// window. A different tracked-tool key, untracked tool call, or
		// window expiry resets the count.
		const continueStreak = sameKey && withinWindow;
		const nextCount = continueStreak ? state!.entry.count + 1 : 1;
		const firstSeenMs = continueStreak ? state!.entry.firstSeenMs : now;
		ledger.set(scope, {
			lastKey: key,
			entry: { count: nextCount, firstSeenMs, lastSeenMs: now },
		});

		// Opportunistically drop scopes whose last activity is past the
		// window, so the ledger doesn't grow unbounded across long-lived
		// daemons.
		if (ledger.size > 256) {
			for (const [k, v] of ledger) {
				if (now - v.entry.lastSeenMs > finalConfig.windowMs) ledger.delete(k);
			}
		}

		if (nextCount >= threshold) {
			const argSummary = summariseArgs(tool_name, args);
			const reason = buildRecoveryMessage(tool_name, nextCount, argSummary);
			logger.warn(
				`Dead-loop detected (scope=${scope}): ${tool_name} called ${nextCount}x in a row with identical args (${argSummary}); denying.`
			);
			// IMPORTANT: do NOT reset the streak on a deny. If the agent
			// retries the same key without doing anything different, the
			// streak continues to grow and every retry continues to deny.
			// The streak only resets when the agent performs a *different*
			// tool call (tracked OR untracked) or the window expires. This
			// is what actually breaks the loop rather than just throttling
			// it.
			return {
				hookSpecificOutput: {
					hookEventName: 'PreToolUse' as const,
					permissionDecision: 'deny' as const,
					permissionDecisionReason: reason,
				},
			};
		}

		return {};
	};
}
