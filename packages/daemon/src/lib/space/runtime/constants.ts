/**
 * Space Runtime Constants
 *
 * Shared configuration constants for the Space runtime layer.
 */

/**
 * Default timeout for auto-completing a stuck agent.
 *
 * An agent is considered "stuck" when it is alive (session active) but has not
 * called `report_done` after this duration since the task was started. The
 * task is auto-completed with a system-generated result so the workflow can
 * continue without manual intervention.
 *
 * Default: 10 minutes.
 */
export const AGENT_REPORT_DONE_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Per-node role timeout constants (M9.4)
// ---------------------------------------------------------------------------

/** Timeout for coder-role node agents (30 minutes). */
export const CODER_NODE_TIMEOUT_MS = 30 * 60 * 1000;

/** Timeout for reviewer-role node agents (15 minutes). */
export const REVIEWER_NODE_TIMEOUT_MS = 15 * 60 * 1000;

/** Timeout for QA-role node agents (15 minutes). */
export const QA_NODE_TIMEOUT_MS = 15 * 60 * 1000;

/** Timeout for planner-role node agents (20 minutes). */
export const PLANNER_NODE_TIMEOUT_MS = 20 * 60 * 1000;

/** Default timeout for node agents whose role does not match a known preset (30 minutes). */
export const DEFAULT_NODE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Resolve the per-node timeout in milliseconds based on the agent role.
 *
 * Role matching is case-insensitive. Known roles:
 *   - `coder` / `general` → 30 minutes
 *   - `reviewer`          → 15 minutes
 *   - `qa`                → 15 minutes
 *   - `planner`           → 20 minutes
 *   - (anything else)     → 30 minutes (DEFAULT_NODE_TIMEOUT_MS)
 */
export function resolveNodeTimeout(role: string): number {
	const r = role.toLowerCase();
	if (r === 'coder' || r === 'general') return CODER_NODE_TIMEOUT_MS;
	if (r === 'reviewer') return REVIEWER_NODE_TIMEOUT_MS;
	if (r === 'qa') return QA_NODE_TIMEOUT_MS;
	if (r === 'planner') return PLANNER_NODE_TIMEOUT_MS;
	return DEFAULT_NODE_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Network retry constants (M9.4)
// ---------------------------------------------------------------------------

/**
 * Maximum number of retry attempts for transient network errors
 * (e.g. `gh` CLI commands that fail with a network error).
 *
 * Total attempts = 1 initial + MAX_NETWORK_RETRIES retries.
 */
export const MAX_NETWORK_RETRIES = 3;

/**
 * Delay in milliseconds between successive retry attempts.
 * Index 0 = delay before attempt 2, index 1 = before attempt 3, etc.
 * The last entry is reused for any remaining attempts beyond the array length.
 */
export const NETWORK_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000] as const;
