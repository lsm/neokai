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
