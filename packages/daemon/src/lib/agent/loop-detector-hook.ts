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
 * Strategy: a `PreToolUse` hook keeps a per-session ledger of accumulated
 * identical tool invocations within a sliding window. The counter is NOT
 * strictly consecutive — unrelated tool calls in between do not reset it,
 * only window expiry (or a deny) does. Once the count crosses a per-tool
 * threshold, the hook denies the call with a `permissionDecisionReason`
 * that the SDK delivers back to the model as the tool result. The reason
 * text instructs the model to stop re-running the tool and proceed to the
 * next step (e.g. its TodoWrite list).
 *
 * Bash is intentionally NOT tracked — bash output can legitimately change
 * across calls (e.g. polling `git status`, tailing logs) and false positives
 * here would be far worse than the rare degenerate loop. Read / Grep / Glob
 * are pure functions of the file system at a point in time, so two identical
 * invocations seconds apart almost never produce different output.
 */

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { resolve as resolvePath } from 'node:path';
import { Logger } from '../logger';

/**
 * Per-tool detection thresholds and overall hook configuration.
 *
 * `thresholds[toolName]` is the count of accumulated identical invocations
 * (within the sliding window) at which we trigger. A tool absent from
 * `thresholds` is never tracked (passes through).
 */
export interface LoopDetectorConfig {
	enabled: boolean;
	/** Sliding window in milliseconds; entries older than this are forgotten. */
	windowMs: number;
	/**
	 * Per-tool accumulated-call threshold within the sliding window. Tools
	 * omitted here are not tracked.
	 */
	thresholds: Record<string, number>;
}

export const DEFAULT_LOOP_DETECTOR_CONFIG: LoopDetectorConfig = {
	enabled: true,
	windowMs: 60_000,
	thresholds: {
		// Read identity is strong: the SDK already surfaces "File unchanged
		// since last read", so 3 accumulated identical reads in 60s is
		// unambiguous.
		Read: 3,
		// Grep / Glob are slightly noisier (developers genuinely re-run them
		// while exploring), so we set a more permissive threshold.
		Grep: 5,
		Glob: 5,
	},
};

interface LedgerEntry {
	count: number;
	lastSeenMs: number;
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
		`Loop detected: ${toolName} was called ${count} times with identical arguments (${argSummary}) in a short window.`,
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
 * arguments so the defaults in `DEFAULT_LOOP_DETECTOR_CONFIG` apply. Partial
 * configs are merged with the defaults: any threshold left unspecified keeps
 * its default (e.g. passing `{ thresholds: { Read: 2 } }` overrides Read but
 * preserves Grep=5 and Glob=5).
 *
 * @example
 * ```ts
 * const hook = createLoopDetectorHook();
 * options.hooks = { PreToolUse: [{ hooks: [hook] }] };
 * ```
 */
export function createLoopDetectorHook(config: Partial<LoopDetectorConfig> = {}): HookCallback {
	const finalConfig: LoopDetectorConfig = {
		...DEFAULT_LOOP_DETECTOR_CONFIG,
		...config,
		thresholds: {
			...DEFAULT_LOOP_DETECTOR_CONFIG.thresholds,
			...config.thresholds,
		},
	};
	const logger = new Logger('LoopDetectorHook');
	// One ledger per hook instance — each session gets its own hook (the
	// builder constructs hooks per-query), so we don't need to key by session.
	const ledger = new Map<string, LedgerEntry>();

	return async (input, _toolUseID, { signal: _signal }) => {
		if (!finalConfig.enabled) return {};
		if (input.hook_event_name !== 'PreToolUse') return {};

		const preInput = input as PreToolUseHookInput;
		const { tool_name, tool_input, cwd } = preInput;

		const threshold = finalConfig.thresholds[tool_name];
		if (typeof threshold !== 'number') {
			// Tool not tracked — pass through.
			return {};
		}

		const args = (tool_input ?? {}) as Record<string, unknown>;
		const key = `${tool_name}:${buildArgKey(tool_name, args, cwd)}`;
		const now = Date.now();

		const existing = ledger.get(key);
		const withinWindow = existing && now - existing.lastSeenMs <= finalConfig.windowMs;

		const nextCount = withinWindow ? existing.count + 1 : 1;
		ledger.set(key, { count: nextCount, lastSeenMs: now });

		// Opportunistically drop stale entries so the ledger doesn't grow
		// unbounded across long-lived sessions.
		if (ledger.size > 256) {
			for (const [k, v] of ledger) {
				if (now - v.lastSeenMs > finalConfig.windowMs) ledger.delete(k);
			}
		}

		if (nextCount >= threshold) {
			const argSummary = summariseArgs(tool_name, args);
			const reason = buildRecoveryMessage(tool_name, nextCount, argSummary);
			logger.warn(
				`Dead-loop detected: ${tool_name} called ${nextCount}x with identical args (${argSummary}) in a short window; denying.`
			);
			// Reset the counter so the agent isn't permanently denied — if it
			// later legitimately retries (e.g. after editing the file), the
			// ledger starts fresh.
			ledger.delete(key);
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
