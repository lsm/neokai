/**
 * Space Runtime Constants
 *
 * Shared configuration constants for the Space runtime layer.
 *
 * Per-node timeout policy lives with the workflow definition, not here. The
 * runtime knows exactly one timeout default — `DEFAULT_NODE_TIMEOUT_MS`. Any
 * per-slot override is read from `WorkflowNodeAgent.timeoutMs` at runtime by
 * `resolveTimeoutForExecution` (see `space-runtime.ts`). Adding a new agent
 * role no longer requires a runtime change.
 */

// ---------------------------------------------------------------------------
// Per-node default timeout
// ---------------------------------------------------------------------------

/**
 * Default timeout for node agents whose workflow slot does not declare an
 * explicit `timeoutMs`. 4 minutes 30 seconds (270_000 ms) — chosen to stay
 * within the model prompt-cache window so the next interaction can reuse
 * cached context. Per-node overrides are configured on the agent slot in the
 * workflow definition.
 */
export const DEFAULT_NODE_TIMEOUT_MS = 4 * 60 * 1000 + 30 * 1000;

// ---------------------------------------------------------------------------
// Network retry constants (M9.4)
// ---------------------------------------------------------------------------

/**
 * Maximum number of crash-and-retry cycles allowed for a single task agent
 * before the task is escalated to `needs_attention`.
 *
 * When an agent session is detected as dead:
 *   - If the task has crashed fewer than MAX_TASK_AGENT_CRASH_RETRIES times,
 *     it is reset to `pending` for re-spawn (transient failure recovery).
 *   - Once the limit is reached, the task transitions to `needs_attention` so
 *     a human can investigate before any further retries are attempted.
 *
 * This prevents silent infinite crash loops while still tolerating the
 * transient startup failures common in CI and cold-start environments.
 */
export const MAX_TASK_AGENT_CRASH_RETRIES = 2;

/**
 * Maximum number of automatic recovery attempts for a blocked workflow run.
 *
 * When a workflow run enters `blocked` status (e.g. a node agent failed after
 * exhausting its reminder attempts), the runtime will automatically:
 *   1. Reset the blocked node execution to `pending` for re-spawn.
 *   2. Transition the run back to `in_progress`.
 *   3. Emit a `task_retry` notification to the Space Agent.
 *
 * Once this limit is reached, the run stays blocked and a
 * `workflow_run_needs_attention` event is emitted for human/Space Agent
 * escalation.
 */
export const MAX_BLOCKED_RUN_RETRIES = 1;

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
