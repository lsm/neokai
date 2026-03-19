/**
 * Gate Allowlist for WorkflowExecutor
 *
 * Defines the allowlisted command prefixes for quality_check gate evaluation.
 * These commands are safe to run as part of automated quality checks.
 * Commands must start with one of these prefixes (after trim+lowercase) to be
 * accepted for execution.
 */

/**
 * Default allowlisted command prefixes for quality_check gates.
 * Security note: this list is intentionally narrow — only project-local
 * check/test/lint/format commands are permitted.
 */
export const GATE_QUALITY_CHECK_ALLOWLIST: readonly string[] = [
	'bun run check',
	'bun test',
	'bun run lint',
	'bun run typecheck',
	'bun run format:check',
];

/**
 * Default timeout (ms) for gate evaluation when gate.timeoutMs is 0 or unset.
 * 60 seconds is long enough for most check/test commands on a healthy repo.
 */
export const DEFAULT_GATE_TIMEOUT_MS = 60_000;

/**
 * Maximum allowed timeout (ms) for any gate evaluation.
 * Prevents denial-of-service via very large timeoutMs values.
 */
export const MAX_GATE_TIMEOUT_MS = 300_000;
