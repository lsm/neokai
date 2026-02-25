/**
 * Runtime Recovery - Restores room runtime state after daemon restart
 *
 * On startup:
 * 1. Find all in-progress tasks with active pairs
 * 2. For each pair, check session existence and state
 * 3. Re-attach observers for active sessions
 * 4. Fail pairs with lost sessions
 * 5. Resume tick loop
 *
 * Key insight: Recovery is proactive - checks current state before subscribing
 * to future events, so pairs that completed right before crash are processed
 * immediately rather than waiting for the safety net timer.
 */

import type { TaskPairRepository, TaskPair } from './task-pair-repository';
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
 * Scans active pairs and either re-attaches observers or fails
 * pairs with lost sessions.
 */
export async function recoverRuntime(
	roomId: string,
	taskPairRepo: TaskPairRepository,
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

	// Find all active pairs for this room
	const activePairs = taskPairRepo.getActivePairs(roomId);

	for (const pair of activePairs) {
		result.recoveredPairs++;

		switch (pair.pairState) {
			case 'awaiting_craft':
				await recoverAwaitingCraft(
					pair,
					taskPairRepo,
					taskManager,
					observer,
					sessionChecker,
					runtime,
					result
				);
				break;

			case 'awaiting_lead':
				await recoverAwaitingLead(
					pair,
					taskPairRepo,
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
	pair: TaskPair,
	taskPairRepo: TaskPairRepository,
	taskManager: TaskManager,
	observer: SessionObserver,
	sessionChecker: SessionStateChecker,
	runtime: RoomRuntime,
	result: RecoveryResult
): Promise<void> {
	if (!sessionChecker.sessionExists(pair.craftSessionId)) {
		// Session lost - fail the pair and task
		await failPairAndTask(pair, taskPairRepo, taskManager, 'Craft session lost during restart');
		result.failedPairs++;
		return;
	}

	if (sessionChecker.isTerminalState(pair.craftSessionId)) {
		// Already terminal - process immediately
		result.immediateTerminals++;
		await runtime.onCraftTerminalState(pair.id, {
			sessionId: pair.craftSessionId,
			kind: 'completed',
		});
	} else {
		// Still active - observe for future terminal state
		observer.observe(pair.craftSessionId, (state: TerminalState) => {
			runtime.onCraftTerminalState(pair.id, state);
		});
		result.reattachedObservers++;
	}

	// Also observe Lead for when it becomes active
	if (sessionChecker.sessionExists(pair.leadSessionId)) {
		observer.observe(pair.leadSessionId, (state: TerminalState) => {
			runtime.onLeadTerminalState(pair.id, state);
		});
	}
}

async function recoverAwaitingLead(
	pair: TaskPair,
	taskPairRepo: TaskPairRepository,
	taskManager: TaskManager,
	observer: SessionObserver,
	sessionChecker: SessionStateChecker,
	runtime: RoomRuntime,
	result: RecoveryResult
): Promise<void> {
	if (!sessionChecker.sessionExists(pair.leadSessionId)) {
		// Session lost - fail the pair and task
		await failPairAndTask(pair, taskPairRepo, taskManager, 'Lead session lost during restart');
		result.failedPairs++;
		return;
	}

	if (sessionChecker.isTerminalState(pair.leadSessionId)) {
		// Already terminal - process immediately
		result.immediateTerminals++;
		await runtime.onLeadTerminalState(pair.id, {
			sessionId: pair.leadSessionId,
			kind: 'completed',
		});
	} else {
		// Still active - observe for future terminal state
		observer.observe(pair.leadSessionId, (state: TerminalState) => {
			runtime.onLeadTerminalState(pair.id, state);
		});
		result.reattachedObservers++;
	}

	// Also observe Craft for if it becomes active again
	if (sessionChecker.sessionExists(pair.craftSessionId)) {
		observer.observe(pair.craftSessionId, (state: TerminalState) => {
			runtime.onCraftTerminalState(pair.id, state);
		});
	}
}

async function failPairAndTask(
	pair: TaskPair,
	taskPairRepo: TaskPairRepository,
	taskManager: TaskManager,
	reason: string
): Promise<void> {
	taskPairRepo.failPair(pair.id, pair.version);
	await taskManager.failTask(pair.taskId, reason);
}
