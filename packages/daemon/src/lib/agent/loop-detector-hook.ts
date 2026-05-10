/**
 * Loop Detector Hook
 *
 * Detects and recovers from "dead loops" where the agent calls the same
 * tool repeatedly with identical arguments without making forward progress.
 *
 * Real-world trigger (task #324, see task #328): the coder agent called
 * `Read` on `client-event-bridge.ts` ~60 times in a single turn before the
 * user intervened. The file content was unchanged across every read; the
 * agent had entered a degenerate planning state. A separate report (task
 * #333) flagged the same failure mode for Bash — e.g. the agent runs
 * `ls -la .git/hooks 2>&1` 60 times, each time getting the same error, never
 * adjusting its approach.
 *
 * ─── Strategy ───────────────────────────────────────────────────────────
 * `PreToolUse` hook keeps a per-(session, agent) ledger of the *current
 * consecutive streak* — i.e. successive invocations of the same
 * `(tool_name, args)` key with no intervening different tool call. Read /
 * Grep / Glob are pure functions of the filesystem, so identical repeats
 * almost never produce different output: we deny purely on repetition at a
 * low threshold (3–5).
 *
 * Bash needs a different policy because legitimate retries DO produce
 * different output (polling `git status`, re-running `bun test` after a
 * fix). We therefore use a **hybrid**: a companion `PostToolUse` hook
 * records the outcome of each Bash call into a per-key failure ring buffer.
 * The `PreToolUse` hook denies only when ALL of:
 *   1. Bash was called with the same fingerprint N times in a row (N=5).
 *   2. The last N outcomes were all failures.
 *   3. The streak fits inside the sliding window.
 *
 * A successful Bash call clears that key's failure ring, so a flaky command
 * that eventually succeeds does not get blocked on the next attempt. A
 * `PostToolUseFailure` (true SDK error, e.g. hook crash, sandbox kill) is
 * recorded as a failure too.
 *
 * ─── Streak reset ──────────────────────────────────────────────────────
 * The hook is registered for ALL tools (not just tracked ones) so any
 * different action — running a different Bash command, editing a file,
 * even calling a non-tracked inspection tool — counts as a "different
 * action" and resets the streak for the *other* tracked tools. This means
 * a denied Read can be unstuck by an Edit; a denied Bash can be unstuck by
 * a Read, a different Bash, or any other tool call. The streak only
 * persists across truly identical consecutive calls.
 *
 * ─── Scoping ───────────────────────────────────────────────────────────
 * Streaks are tracked per `(session_id, agent_id)` pair, so parallel
 * subagents under the same parent session cannot contribute to each
 * other's counters and a subagent's reads do not pollute the main thread's
 * streak.
 *
 * ─── Repeat denies ─────────────────────────────────────────────────────
 * When a stuck agent keeps hammering the same call after a deny, the streak
 * does NOT reset on a deny — every retry without an intervening different
 * action continues to deny. This is intentional: the goal is to break the
 * loop, not just throttle it. The streak resets when the agent performs a
 * *different* tool call (tracked OR untracked) or the sliding window
 * elapses over the streak's lifetime. For Bash, the deny additionally
 * requires the persistent-failure condition, so a stuck loop of failing
 * commands keeps being denied until the agent does something different OR
 * the next invocation of that same command happens to succeed (which would
 * have to come from outside the deny path, i.e. after a streak reset).
 */

import type {
	HookCallback,
	PostToolUseFailureHookInput,
	PostToolUseHookInput,
	PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
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
 *
 * `bash` configures the failure-aware Bash detector. Bash is intentionally
 * NOT in `thresholds` because we do not deny purely on repetition — the
 * Bash detector requires both a streak AND a recent failure history. Set
 * `bash.enabled = false` to disable Bash detection entirely.
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
	/** Bash-specific failure-aware detector. */
	bash?: BashLoopConfig;
}

/**
 * Bash dead-loop detector configuration.
 *
 * Bash output can legitimately change across calls (polling `git status`,
 * re-running `bun test` after a fix), so denying purely on repetition would
 * produce false positives. Instead, we require BOTH a consecutive streak of
 * identical commands AND a run of recent failures: this targets the
 * "agent re-runs the same broken command over and over" pattern without
 * blocking legitimate retries that eventually succeed.
 *
 * Failure detection runs in a companion `PostToolUse` hook that classifies
 * each Bash result as success or failure based on the tool response shape
 * (see `isBashFailureResponse`). `PostToolUseFailure` events (true SDK
 * errors) are always counted as failures.
 */
export interface BashLoopConfig {
	/** When false, Bash is never denied or tracked by this module. */
	enabled: boolean;
	/**
	 * Consecutive-streak length at which we consider denying. Higher than
	 * Read/Grep/Glob because Bash retries are more often legitimate.
	 */
	threshold: number;
	/**
	 * Number of recent outcomes per command fingerprint to keep in the
	 * failure ring. The deny check passes only when the most recent
	 * `failuresRequired` outcomes are all failures.
	 */
	failuresRequired: number;
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
	bash: {
		enabled: true,
		// 5 identical consecutive Bash calls is already unusual; combined with
		// the all-failures requirement this rarely fires on legitimate
		// workflows.
		threshold: 5,
		// All of the most recent 5 outcomes must be failures. A single
		// success anywhere in the window clears the denial.
		failuresRequired: 5,
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
	if (toolName === 'Bash' && typeof input.command === 'string') {
		candidates.push(`command=${(input.command as string).slice(0, 160)}`);
	}
	if (candidates.length === 0) return JSON.stringify(input).slice(0, 120);
	return candidates.join(', ').slice(0, 240);
}

function buildRecoveryMessage(toolName: string, count: number, argSummary: string): string {
	return [
		`Loop detected: ${toolName} was called ${count} times in a row with identical arguments (${argSummary}).`,
		'The result has not changed since the previous call. STOP re-running this tool — move on to the next step in your task.',
		'If you have a TodoWrite list, mark progress and proceed to the next item.',
		'If you genuinely need fresh data, perform a *different* action (edit a file, run a command, ask a question) before retrying.',
	].join(' ');
}

function buildBashRecoveryMessage(count: number, argSummary: string, failures: number): string {
	return [
		`Bash dead-loop detected: the same command was run ${count} times in a row and the last ${failures} attempts all failed (${argSummary}).`,
		'Re-running the same failing command will not change the outcome. STOP and reconsider:',
		'(1) read the previous error output carefully,',
		'(2) inspect the relevant files or run a *different* diagnostic command,',
		'(3) only retry after you have changed something that could plausibly affect the outcome.',
		'If you are checking for a file or path, run a different probe (e.g. `ls` on the parent directory) instead of re-running the failing command.',
	].join(' ');
}

/**
 * Classify a Bash tool response as a failure or success.
 *
 * The SDK delivers `tool_response` as `unknown`; in practice for Bash it is
 * one of:
 *   - a string (success: command produced stdout/stderr text)
 *   - an object `{ stdout, stderr, interrupted, isImageOutput, ... }`
 *   - a content-block array `[{ type: 'text', text: '...' }, ...]` with
 *     `is_error: true` set at the top level when the tool errored
 *
 * We treat the following as failures:
 *   - response has `is_error: true`
 *   - response has `interrupted: true`
 *   - response contains an exit-code marker indicating non-zero exit
 *     (`Exit code: <n>` with n != 0, or `<bash-stderr>` blocks containing
 *     "command not found", "Permission denied", etc.)
 *
 * False negatives are acceptable (we just don't fire on that specific
 * outcome); false positives are NOT (we'd block legitimate retries), so the
 * classifier is intentionally conservative — when in doubt, treat as success.
 */
export function isBashFailureResponse(response: unknown): boolean {
	if (response == null) return false;

	// Top-level object with explicit error markers.
	if (typeof response === 'object' && !Array.isArray(response)) {
		const obj = response as Record<string, unknown>;
		if (obj.is_error === true) return true;
		if (obj.interrupted === true) return true;
		// Some SDK shapes surface the exit code in a `metadata` or direct field.
		const exitCode = (obj.exitCode ?? obj.exit_code ?? obj.returnCode) as unknown;
		if (typeof exitCode === 'number' && exitCode !== 0) return true;

		// Recurse into common text-bearing fields.
		if (typeof obj.stderr === 'string' && containsBashErrorMarker(obj.stderr)) return true;
		if (typeof obj.stdout === 'string' && containsBashErrorMarker(obj.stdout)) return true;
		if (typeof obj.text === 'string' && containsBashErrorMarker(obj.text)) return true;
		return false;
	}

	// Content-block array shape: any text block matching error markers.
	if (Array.isArray(response)) {
		for (const block of response) {
			if (block && typeof block === 'object') {
				const b = block as Record<string, unknown>;
				if (b.is_error === true) return true;
				if (typeof b.text === 'string' && containsBashErrorMarker(b.text)) return true;
			}
		}
		return false;
	}

	if (typeof response === 'string') {
		return containsBashErrorMarker(response);
	}

	return false;
}

/**
 * Detect strong textual signals of a failed shell command. Conservative:
 * we'd rather miss a failure than misclassify a success.
 */
function containsBashErrorMarker(text: string): boolean {
	// Normalise to a single-line lowercased haystack for substring checks.
	const lower = text.toLowerCase();
	if (/exit code:\s*(?!0\b)\d+/i.test(text)) return true;
	if (/<bash-stderr>/.test(text) && !/<bash-stderr>\s*<\/bash-stderr>/.test(text)) return true;
	if (lower.includes('command not found')) return true;
	if (lower.includes('no such file or directory')) return true;
	if (lower.includes('permission denied')) return true;
	if (lower.includes('command timed out')) return true;
	if (lower.includes('error: ') && lower.includes('failed')) return true;
	return false;
}

/**
 * Shared per-(session, agent) state used by the PreToolUse, PostToolUse,
 * and PostToolUseFailure hooks. The three hooks are produced by a single
 * factory so they reference the same Maps.
 */
interface LoopDetectorState {
	/**
	 * Streak ledger for tracked tools (Read, Grep, Glob) PLUS the in-flight
	 * Bash streak. Bash uses this ledger for the streak counter; the Bash
	 * deny decision additionally consults `bashFailures` keyed by
	 * `(scope, fingerprint)`.
	 */
	ledger: Map<string, AgentState>;
	/**
	 * Bash failure ring buffers, keyed by `${scope}::${bashFingerprint}`.
	 * Each entry holds the most recent N outcomes (true = failure, false =
	 * success), most recent last. We trim to `bash.failuresRequired` entries
	 * on each append.
	 */
	bashFailures: Map<string, boolean[]>;
}

function createState(): LoopDetectorState {
	return {
		ledger: new Map(),
		bashFailures: new Map(),
	};
}

function scopeKey(input: { session_id: string; agent_id?: string }): string {
	return `${input.session_id}::${input.agent_id ?? 'main'}`;
}

function bashFingerprintKey(scope: string, fingerprint: string): string {
	return `${scope}::${fingerprint}`;
}

function recordBashOutcome(
	state: LoopDetectorState,
	scope: string,
	fingerprint: string,
	failed: boolean,
	failuresRequired: number
): void {
	const key = bashFingerprintKey(scope, fingerprint);
	const ring = state.bashFailures.get(key) ?? [];
	ring.push(failed);
	// Keep at most `failuresRequired` outcomes so the deny check is O(1).
	while (ring.length > failuresRequired) ring.shift();
	state.bashFailures.set(key, ring);
}

function lastNAllFailures(
	state: LoopDetectorState,
	scope: string,
	fingerprint: string
): {
	allFailures: boolean;
	length: number;
} {
	const ring = state.bashFailures.get(bashFingerprintKey(scope, fingerprint)) ?? [];
	if (ring.length === 0) return { allFailures: false, length: 0 };
	for (const failed of ring) {
		if (!failed) return { allFailures: false, length: ring.length };
	}
	return { allFailures: true, length: ring.length };
}

/**
 * Resolve a partial config into a fully-populated config, preserving the
 * "thresholds REPLACE" contract while still merging the bash sub-config
 * field-by-field. Bash defaults can be partially overridden because the
 * sub-config is a flat shape with no "set of tools" semantic to preserve.
 */
function resolveConfig(config: Partial<LoopDetectorConfig>): Required<LoopDetectorConfig> {
	const bashDefaults = DEFAULT_LOOP_DETECTOR_CONFIG.bash;
	const bashOverride = config.bash;
	return {
		enabled: config.enabled ?? DEFAULT_LOOP_DETECTOR_CONFIG.enabled,
		windowMs: config.windowMs ?? DEFAULT_LOOP_DETECTOR_CONFIG.windowMs,
		// REPLACE — do not merge. A caller passing { Read: 2 } means "track
		// only Read." This is what the contract on LoopDetectorConfig
		// promises. Pass undefined / omit to keep the defaults wholesale.
		thresholds: config.thresholds ?? DEFAULT_LOOP_DETECTOR_CONFIG.thresholds,
		bash: bashOverride
			? {
					enabled: bashOverride.enabled ?? bashDefaults.enabled,
					threshold: bashOverride.threshold ?? bashDefaults.threshold,
					failuresRequired: bashOverride.failuresRequired ?? bashDefaults.failuresRequired,
				}
			: bashDefaults,
	};
}

/**
 * Build the PreToolUse callback. Shared across `createLoopDetectorHook`
 * (single-callback factory for callers that only want pre-hooks) and
 * `createLoopDetectorHooks` (paired factory that also returns post-hooks
 * sharing the same state).
 */
function buildPreToolUseCallback(
	state: LoopDetectorState,
	finalConfig: Required<LoopDetectorConfig>,
	logger: Logger
): HookCallback {
	return async (input, _toolUseID, { signal: _signal }) => {
		if (!finalConfig.enabled) return {};
		if (input.hook_event_name !== 'PreToolUse') return {};

		const preInput = input as PreToolUseHookInput;
		const { tool_name, tool_input, cwd, session_id, agent_id } = preInput;

		const scope = scopeKey({ session_id, agent_id });
		const threshold = finalConfig.thresholds[tool_name];
		const isBash = tool_name === 'Bash' && finalConfig.bash.enabled;
		const now = Date.now();

		// Untracked tool (Edit, Write, an unknown tool, …) is treated as a
		// *different action*: it resets any in-flight streak for this scope
		// so that a genuine corrective step lets the next identical tracked
		// call pass through. Bash IS tracked (under its own ledger entry)
		// when bash.enabled, so falls through to the streak logic below.
		if (typeof threshold !== 'number' && !isBash) {
			state.ledger.delete(scope);
			return {};
		}

		const args = (tool_input ?? {}) as Record<string, unknown>;
		const key = `${tool_name}:${buildArgKey(tool_name, args, cwd)}`;

		const agentState = state.ledger.get(scope);
		const sameKey = agentState?.lastKey === key;
		// Sliding window is enforced over the *full streak duration*, not
		// just the gap between successive calls. A sequence at t=0,59s,118s
		// with a 60s window has duration 118s > 60s on the third call, so
		// the streak resets to 1 — matching "N repeats within window"
		// semantics rather than "max inter-call gap".
		const withinWindow = agentState && now - agentState.entry.firstSeenMs <= finalConfig.windowMs;

		// Strict consecutive semantics: streak only continues when the same
		// key is invoked AND the *whole* streak still fits in the sliding
		// window. A different tracked-tool key, untracked tool call, or
		// window expiry resets the count.
		const continueStreak = sameKey && withinWindow;
		const nextCount = continueStreak ? agentState!.entry.count + 1 : 1;
		const firstSeenMs = continueStreak ? agentState!.entry.firstSeenMs : now;
		state.ledger.set(scope, {
			lastKey: key,
			entry: { count: nextCount, firstSeenMs, lastSeenMs: now },
		});

		// Opportunistically drop scopes whose last activity is past the
		// window, so the ledger doesn't grow unbounded across long-lived
		// daemons.
		if (state.ledger.size > 256) {
			for (const [k, v] of state.ledger) {
				if (now - v.entry.lastSeenMs > finalConfig.windowMs) state.ledger.delete(k);
			}
		}

		// Bash deny path: streak + persistent-failure required.
		if (isBash) {
			const bashThreshold = finalConfig.bash.threshold;
			if (nextCount >= bashThreshold) {
				const fingerprint = buildArgKey('Bash', args, cwd);
				const { allFailures, length } = lastNAllFailures(state, scope, fingerprint);
				if (allFailures && length >= finalConfig.bash.failuresRequired) {
					const argSummary = summariseArgs('Bash', args);
					const reason = buildBashRecoveryMessage(nextCount, argSummary, length);
					logger.warn(
						`Bash dead-loop detected (scope=${scope}): same command ${nextCount}x in a row, last ${length} all failed (${argSummary}); denying.`
					);
					return {
						hookSpecificOutput: {
							hookEventName: 'PreToolUse' as const,
							permissionDecision: 'deny' as const,
							permissionDecisionReason: reason,
						},
					};
				}
			}
			return {};
		}

		// Non-Bash tracked tool path: deny purely on repetition.
		if (typeof threshold === 'number' && nextCount >= threshold) {
			const argSummary = summariseArgs(tool_name, args);
			const reason = buildRecoveryMessage(tool_name, nextCount, argSummary);
			logger.warn(
				`Dead-loop detected (scope=${scope}): ${tool_name} called ${nextCount}x in a row with identical args (${argSummary}); denying.`
			);
			// IMPORTANT: do NOT reset the streak on a deny. If the agent
			// retries the same key without doing anything different, the
			// streak continues to grow and every retry continues to deny.
			// The streak only resets when the agent performs a *different*
			// tool call (tracked OR untracked) or the window expires.
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

/**
 * Build the PostToolUse callback. Records Bash outcomes into the shared
 * failure ring buffer; otherwise a no-op.
 */
function buildPostToolUseCallback(
	state: LoopDetectorState,
	finalConfig: Required<LoopDetectorConfig>
): HookCallback {
	return async (input, _toolUseID, { signal: _signal }) => {
		if (!finalConfig.enabled) return {};
		if (!finalConfig.bash.enabled) return {};
		if (input.hook_event_name !== 'PostToolUse') return {};

		const postInput = input as PostToolUseHookInput;
		if (postInput.tool_name !== 'Bash') return {};

		const args = (postInput.tool_input ?? {}) as Record<string, unknown>;
		const fingerprint = buildArgKey('Bash', args, postInput.cwd);
		const scope = scopeKey(postInput);
		const failed = isBashFailureResponse(postInput.tool_response);
		recordBashOutcome(state, scope, fingerprint, failed, finalConfig.bash.failuresRequired);
		return {};
	};
}

/**
 * Build the PostToolUseFailure callback. A true SDK error (hook crash,
 * sandbox kill, timeout) is always recorded as a failure for the Bash
 * fingerprint.
 */
function buildPostToolUseFailureCallback(
	state: LoopDetectorState,
	finalConfig: Required<LoopDetectorConfig>
): HookCallback {
	return async (input, _toolUseID, { signal: _signal }) => {
		if (!finalConfig.enabled) return {};
		if (!finalConfig.bash.enabled) return {};
		if (input.hook_event_name !== 'PostToolUseFailure') return {};

		const postInput = input as PostToolUseFailureHookInput;
		if (postInput.tool_name !== 'Bash') return {};

		const args = (postInput.tool_input ?? {}) as Record<string, unknown>;
		const fingerprint = buildArgKey('Bash', args, postInput.cwd);
		const scope = scopeKey(postInput);
		recordBashOutcome(state, scope, fingerprint, true, finalConfig.bash.failuresRequired);
		return {};
	};
}

/**
 * Create a PreToolUse hook that detects dead loops and short-circuits them.
 *
 * Backwards-compatible single-callback factory. For Bash dead-loop
 * detection to function correctly, pair this with the post-hooks returned
 * by `createLoopDetectorHooks` (or use that factory exclusively). Calling
 * `createLoopDetectorHook` on its own still installs the Bash *streak*
 * tracker, but with no PostToolUse observer the failure ring will stay
 * empty, so Bash will never be denied — only Read/Grep/Glob denies fire.
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
	const finalConfig = resolveConfig(config);
	const logger = new Logger('LoopDetectorHook');
	const state = createState();
	return buildPreToolUseCallback(state, finalConfig, logger);
}

/**
 * Triple-callback factory: returns matched PreToolUse + PostToolUse +
 * PostToolUseFailure hooks that share state. Production callers should use
 * this so Bash dead-loop detection actually has outcome information to
 * consult.
 *
 * @example
 * ```ts
 * const { preToolUse, postToolUse, postToolUseFailure } = createLoopDetectorHooks();
 * options.hooks = {
 *   PreToolUse: [{ hooks: [preToolUse] }],
 *   PostToolUse: [{ hooks: [postToolUse] }],
 *   PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
 * };
 * ```
 */
export function createLoopDetectorHooks(config: Partial<LoopDetectorConfig> = {}): {
	preToolUse: HookCallback;
	postToolUse: HookCallback;
	postToolUseFailure: HookCallback;
} {
	const finalConfig = resolveConfig(config);
	const logger = new Logger('LoopDetectorHook');
	const state = createState();
	return {
		preToolUse: buildPreToolUseCallback(state, finalConfig, logger),
		postToolUse: buildPostToolUseCallback(state, finalConfig),
		postToolUseFailure: buildPostToolUseFailureCallback(state, finalConfig),
	};
}
