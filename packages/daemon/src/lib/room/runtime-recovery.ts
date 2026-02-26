/**
 * Runtime Recovery - Restores room runtime state after daemon restart
 *
 * On startup:
 * 1. Find all in-progress tasks with active groups
 * 2. For each group, check session existence and state
 * 3. Re-attach observers for active sessions
 * 4. Fail groups with lost sessions
 * 5. Resume tick loop
 *
 * Key insight: Recovery is proactive - checks current state before subscribing
 * to future events, so groups that completed right before crash are processed
 * immediately rather than waiting for the safety net timer.
 */

import type { SessionGroupRepository, SessionGroup } from './session-group-repository';
import type { SessionObserver, TerminalState } from './session-observer';
import type { TaskManager } from './task-manager';
import type { RoomRuntime } from './room-runtime';

/**
 * Interface for checking session existence and state.
 * Injected for testability.
 */
export interface SessionStateChecker {
	sessionExists(sessionId: string): boolean;
	isTerminalState(sessionId: string): boolean;
}

export interface RecoveryResult {
	recoveredPairs: number;
	failedPairs: number;
	reattachedObservers: number;
	immediateTerminals: number;
}

/**
 * Recover room runtime state after daemon restart.
 *
 * Scans active groups and either re-attaches observers or fails
 * groups with lost sessions.
 */
export async function recoverRuntime(
	roomId: string,
	groupRepo: SessionGroupRepository,
	taskManager: TaskManager,
	observer: SessionObserver,
	sessionChecker: SessionStateChecker,
	runtime: RoomRuntime
): Promise<RecoveryResult> {
	const result: RecoveryResult = {
		recoveredPairs: 0,
		failedPairs: 0,
		reattachedObservers: 0,
		immediateTerminals: 0,
	};

	// Find all active groups for this room
	const activeGroups = groupRepo.getActiveGroups(roomId);

	for (const group of activeGroups) {
		result.recoveredPairs++;

		switch (group.state) {
			case 'awaiting_craft':
				await recoverAwaitingCraft(
					group,
					groupRepo,
					taskManager,
					observer,
					sessionChecker,
					runtime,
					result
				);
				break;

			case 'awaiting_lead':
				await recoverAwaitingLead(
					group,
					groupRepo,
					taskManager,
					observer,
					sessionChecker,
					runtime,
					result
				);
				break;

			case 'awaiting_human':
			case 'hibernated':
				// No action needed - waiting for external input
				break;
		}
	}

	return result;
}

async function recoverAwaitingCraft(
	group: SessionGroup,
	groupRepo: SessionGroupRepository,
	taskManager: TaskManager,
	observer: SessionObserver,
	sessionChecker: SessionStateChecker,
	runtime: RoomRuntime,
	result: RecoveryResult
): Promise<void> {
	if (!sessionChecker.sessionExists(group.craftSessionId)) {
		// Session lost - fail the group and task
		await failGroupAndTask(group, groupRepo, taskManager, 'Craft session lost during restart');
		result.failedPairs++;
		return;
	}

	if (sessionChecker.isTerminalState(group.craftSessionId)) {
		// Already terminal - process immediately
		result.immediateTerminals++;
		await runtime.onCraftTerminalState(group.id, {
			sessionId: group.craftSessionId,
			kind: 'completed',
		});
	} else {
		// Still active - observe for future terminal state
		observer.observe(group.craftSessionId, (state: TerminalState) => {
			runtime.onCraftTerminalState(group.id, state);
		});
		result.reattachedObservers++;
	}

	// Also observe Lead for when it becomes active
	if (sessionChecker.sessionExists(group.leadSessionId)) {
		observer.observe(group.leadSessionId, (state: TerminalState) => {
			runtime.onLeadTerminalState(group.id, state);
		});
	}
}

async function recoverAwaitingLead(
	group: SessionGroup,
	groupRepo: SessionGroupRepository,
	taskManager: TaskManager,
	observer: SessionObserver,
	sessionChecker: SessionStateChecker,
	runtime: RoomRuntime,
	result: RecoveryResult
): Promise<void> {
	if (!sessionChecker.sessionExists(group.leadSessionId)) {
		// Session lost - fail the group and task
		await failGroupAndTask(group, groupRepo, taskManager, 'Lead session lost during restart');
		result.failedPairs++;
		return;
	}

	if (sessionChecker.isTerminalState(group.leadSessionId)) {
		// Already terminal - process immediately
		result.immediateTerminals++;
		await runtime.onLeadTerminalState(group.id, {
			sessionId: group.leadSessionId,
			kind: 'completed',
		});
	} else {
		// Still active - observe for future terminal state
		observer.observe(group.leadSessionId, (state: TerminalState) => {
			runtime.onLeadTerminalState(group.id, state);
		});
		result.reattachedObservers++;
	}

	// Also observe Craft for if it becomes active again
	if (sessionChecker.sessionExists(group.craftSessionId)) {
		observer.observe(group.craftSessionId, (state: TerminalState) => {
			runtime.onCraftTerminalState(group.id, state);
		});
	}
}

async function failGroupAndTask(
	group: SessionGroup,
	groupRepo: SessionGroupRepository,
	taskManager: TaskManager,
	reason: string
): Promise<void> {
	groupRepo.failGroup(group.id, group.version);
	await taskManager.failTask(group.taskId, reason);
}
