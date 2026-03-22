/**
 * Runtime Recovery - Restores room runtime state after daemon restart
 *
 * On startup:
 * 1. Find all in-progress tasks with active groups
 * 2. For each group, restore sessions into in-memory cache
 * 3. Re-attach observers for active sessions
 * 4. Fail groups with lost or unrestorable sessions
 * 5. Resume tick loop
 *
 * Key insight: Recovery is proactive - checks current state before subscribing
 * to future events, so groups that completed right before crash are processed
 * immediately rather than waiting for the safety net timer.
 *
 * Simplified model: No group state machine. Both worker and leader sessions
 * are restored and observed. If submittedForReview is true, the group is
 * awaiting human action.
 */

import type { SessionGroupRepository, SessionGroup } from '../state/session-group-repository';
import type { SessionObserver, TerminalState } from '../state/session-observer';
import type { TaskManager } from '../managers/task-manager';
import type { RoomRuntime } from './room-runtime';

/**
 * Interface for checking session existence, liveness, and restoration.
 * Injected for testability.
 */
export interface SessionStateChecker {
	/** Check if the session row exists in DB */
	sessionExists(sessionId: string): boolean;
	/** Check if the session is in a terminal processing state */
	isTerminalState(sessionId: string): boolean;
	/** Check if the session is live in the in-memory AgentSession cache */
	isLive(sessionId: string): boolean;
	/** Restore a session from DB into the in-memory cache and start streaming. */
	restoreSession(sessionId: string): Promise<boolean>;
}

export interface RecoveryResult {
	recoveredGroups: number;
	failedGroups: number;
	reattachedObservers: number;
	immediateTerminals: number;
	restoredSessions: number;
}

/**
 * Recover room runtime state after daemon restart.
 *
 * Scans active groups and either restores + re-attaches observers or fails
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
		recoveredGroups: 0,
		failedGroups: 0,
		reattachedObservers: 0,
		immediateTerminals: 0,
		restoredSessions: 0,
	};

	// Find all active groups for this room
	const activeGroups = groupRepo.getActiveGroups(roomId);

	for (const group of activeGroups) {
		result.recoveredGroups++;

		await recoverGroup(group, groupRepo, taskManager, observer, sessionChecker, runtime, result);
	}

	return result;
}

/**
 * Ensure a session is live (in the in-memory cache). If not, restore from DB.
 * Returns true if session is live after this call, false if unrestorable.
 */
async function ensureLive(
	sessionId: string,
	sessionChecker: SessionStateChecker,
	result: RecoveryResult
): Promise<boolean> {
	if (sessionChecker.isLive(sessionId)) return true;
	if (!sessionChecker.sessionExists(sessionId)) return false;

	const restored = await sessionChecker.restoreSession(sessionId);
	if (restored) {
		result.restoredSessions++;
	}
	return restored;
}

/**
 * Recover a group by restoring both worker and leader sessions.
 *
 * Simplified recovery: No state machine. Both sessions are restored if they exist.
 * If submittedForReview is true, the group is awaiting human action but sessions
 * are still kept live for message injection.
 */
async function recoverGroup(
	group: SessionGroup,
	groupRepo: SessionGroupRepository,
	taskManager: TaskManager,
	observer: SessionObserver,
	sessionChecker: SessionStateChecker,
	runtime: RoomRuntime,
	result: RecoveryResult
): Promise<void> {
	// Restore worker into memory if not live
	const workerLive = await ensureLive(group.workerSessionId, sessionChecker, result);
	if (!workerLive) {
		await failGroupAndTask(group, groupRepo, taskManager, 'Worker session lost during restart');
		result.failedGroups++;
		return;
	}

	// Check if worker is already in terminal state
	if (sessionChecker.isTerminalState(group.workerSessionId)) {
		// Already terminal - process immediately
		result.immediateTerminals++;
		await runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});
	} else {
		// Still active - observe for future terminal state
		observer.observe(group.workerSessionId, (state: TerminalState) => {
			runtime.onWorkerTerminalState(group.id, state);
		});
		result.reattachedObservers++;
	}

	// Restore and observe leader if it exists
	// Leader may be lazily created, so session might not exist yet
	if (sessionChecker.sessionExists(group.leaderSessionId)) {
		const leaderLive = await ensureLive(group.leaderSessionId, sessionChecker, result);
		if (leaderLive) {
			if (sessionChecker.isTerminalState(group.leaderSessionId)) {
				result.immediateTerminals++;
				await runtime.onLeaderTerminalState(group.id, {
					sessionId: group.leaderSessionId,
					kind: 'idle',
				});
			} else {
				observer.observe(group.leaderSessionId, (state: TerminalState) => {
					runtime.onLeaderTerminalState(group.id, state);
				});
				result.reattachedObservers++;
			}
		}
	} else {
		// Leader session doesn't exist yet - observe anyway for lazy creation
		observer.observe(group.leaderSessionId, (state: TerminalState) => {
			runtime.onLeaderTerminalState(group.id, state);
		});
	}
}

async function failGroupAndTask(
	group: SessionGroup,
	groupRepo: SessionGroupRepository,
	taskManager: TaskManager,
	_reason: string
): Promise<void> {
	groupRepo.failGroup(group.id, group.version);
	// Reset task to pending so it is automatically re-spawned on the next tick.
	// After a daemon restart, lost sessions are a transient condition — the task
	// should retry rather than require human intervention ('needs_attention').
	await taskManager.resetTaskToPending(group.taskId);
}
