/**
 * Agent Liveness Guard — Timeout for report_done
 *
 * Detects agents that are alive (session active) but have not called
 * `report_done` within the configured timeout. Auto-completes them with a
 * system-generated result so the workflow can continue.
 *
 * An agent is considered "stuck" when ALL of the following are true:
 *   1. The task status is `'in_progress'`.
 *   2. The task has a `taskAgentSessionId` (a Task Agent was spawned for it).
 *   3. The Task Agent session is alive (`isTaskAgentAlive()` returns `true`).
 *   4. Elapsed time since `startedAt` exceeds the configured timeout.
 *
 * Dead agents (where `isTaskAgentAlive()` returns `false`) are excluded because
 * they are already handled by the dead-agent reset path in SpaceRuntime —
 * resetting them to `'pending'` for re-spawn on the next tick.
 */

import type { SpaceTask } from '@neokai/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { TaskAgentManager } from './task-agent-manager';
import type { SpaceNotificationEvent } from './notification-sink';
import { AGENT_REPORT_DONE_TIMEOUT_MS } from './constants';
import { Logger } from '../../logger';

const log = new Logger('agent-liveness');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Describes a single agent that was auto-completed by `autoCompleteStuckAgents`.
 */
export interface AutoCompletedAgent {
	/** ID of the task that was auto-completed. */
	taskId: string;
	/** Milliseconds elapsed since the task started at the time of auto-completion. */
	elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Scans `stepTasks` for alive agents that have not called `report_done` within
 * `timeoutMs` milliseconds and auto-completes them.
 *
 * For each stuck agent found:
 *   - Sets task status to `'completed'` with a system-generated result.
 *   - Emits an `agent_auto_completed` notification event.
 *
 * @param stepTasks      Tasks belonging to the current workflow step.
 * @param spaceId        Space ID (used in notification events).
 * @param taskRepo       Repository for persisting task status updates.
 * @param tam            Task Agent Manager for liveness checks.
 * @param notify         Notification callback (should be the `safeNotify` wrapper).
 * @param timeoutMs      Timeout in milliseconds (default: AGENT_REPORT_DONE_TIMEOUT_MS).
 * @returns              List of tasks that were auto-completed.
 */
export async function autoCompleteStuckAgents(
	stepTasks: SpaceTask[],
	spaceId: string,
	taskRepo: SpaceTaskRepository,
	tam: TaskAgentManager,
	notify: (event: SpaceNotificationEvent) => Promise<void>,
	timeoutMs: number = AGENT_REPORT_DONE_TIMEOUT_MS
): Promise<AutoCompletedAgent[]> {
	const now = Date.now();
	const autoCompleted: AutoCompletedAgent[] = [];

	for (const task of stepTasks) {
		// Only check in_progress tasks that have a Task Agent session assigned.
		if (task.status !== 'in_progress' || !task.taskAgentSessionId) {
			continue;
		}

		// Skip dead agents — handled by the dead-agent reset path.
		if (!tam.isTaskAgentAlive(task.id)) {
			continue;
		}

		// Use startedAt as the reference point; fall back to createdAt if missing.
		const referenceTime = task.startedAt ?? task.createdAt;
		const elapsedMs = now - referenceTime;

		if (elapsedMs <= timeoutMs) {
			continue;
		}

		// Agent is alive but has not called report_done within the timeout window.
		const timeoutMinutes = Math.round(timeoutMs / 60_000);
		const result = `Auto-completed: agent did not call report_done within ${timeoutMinutes} minutes`;

		log.warn(
			`agent-liveness: auto-completing stuck task ${task.id} ` +
				`(elapsed ${Math.round(elapsedMs / 1000)}s, timeout ${timeoutMinutes}m)`
		);

		taskRepo.updateTask(task.id, {
			status: 'completed',
			result,
		});

		await notify({
			kind: 'agent_auto_completed',
			spaceId,
			taskId: task.id,
			elapsedMs,
			timestamp: new Date().toISOString(),
		});

		autoCompleted.push({ taskId: task.id, elapsedMs });
	}

	return autoCompleted;
}
