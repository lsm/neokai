/**
 * Goal RPC Handlers
 *
 * RPC handlers for goal operations:
 * - goal.create - Create a new goal
 * - goal.get - Get goal details
 * - goal.list - List goals in room
 * - goal.updateStatus - Update goal status
 * - goal.updateProgress - Update goal progress
 * - goal.updatePriority - Update goal priority
 * - goal.start - Start a goal (mark as in_progress)
 * - goal.complete - Complete a goal
 * - goal.block - Block a goal
 * - goal.unblock - Unblock a goal
 * - goal.linkTask - Link a task to a goal
 * - goal.unlinkTask - Unlink a task from a goal
 * - goal.delete - Delete a goal
 * - goal.getNext - Get next goal to work on
 * - goal.getActive - Get all active goals
 */

import type { MessageHub, RoomGoal, GoalStatus, GoalPriority } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { GoalManager } from '../room/goal-manager';

export type GoalManagerLike = Pick<
	GoalManager,
	| 'createGoal'
	| 'getGoal'
	| 'listGoals'
	| 'updateGoalStatus'
	| 'updateGoalProgress'
	| 'updateGoalPriority'
	| 'startGoal'
	| 'completeGoal'
	| 'blockGoal'
	| 'unblockGoal'
	| 'linkTaskToGoal'
	| 'unlinkTaskFromGoal'
	| 'deleteGoal'
	| 'getNextGoal'
	| 'getActiveGoals'
>;

export type GoalManagerFactory = (roomId: string) => GoalManagerLike;

export function setupGoalHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	goalManagerFactory: GoalManagerFactory
): void {
	/**
	 * Emit goal.created event to notify UI clients
	 */
	const emitGoalCreated = (roomId: string, goal: RoomGoal) => {
		daemonHub
			.emit('goal.created', {
				sessionId: `room:${roomId}`,
				roomId,
				goalId: goal.id,
				goal,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	/**
	 * Emit goal.updated event to notify UI clients
	 */
	const emitGoalUpdated = (roomId: string, goalId: string, goal?: RoomGoal) => {
		daemonHub
			.emit('goal.updated', {
				sessionId: `room:${roomId}`,
				roomId,
				goalId,
				goal,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	/**
	 * Emit goal.progressUpdated event to notify UI clients
	 */
	const emitGoalProgressUpdated = (roomId: string, goalId: string, progress: number) => {
		daemonHub
			.emit('goal.progressUpdated', {
				sessionId: `room:${roomId}`,
				roomId,
				goalId,
				progress,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	/**
	 * Emit goal.completed event to notify UI clients
	 */
	const emitGoalCompleted = (roomId: string, goal: RoomGoal) => {
		daemonHub
			.emit('goal.completed', {
				sessionId: `room:${roomId}`,
				roomId,
				goalId: goal.id,
				goal,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	// goal.create - Create a new goal
	messageHub.onRequest('goal.create', async (data) => {
		const params = data as {
			roomId: string;
			title: string;
			description?: string;
			priority?: GoalPriority;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.title) {
			throw new Error('Goal title is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.createGoal({
			title: params.title,
			description: params.description ?? '',
			priority: params.priority,
		});

		// Emit goal.created event
		emitGoalCreated(params.roomId, goal);

		return { goal };
	});

	// goal.get - Get goal details
	messageHub.onRequest('goal.get', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.getGoal(params.goalId);

		if (!goal) {
			throw new Error(`Goal not found: ${params.goalId}`);
		}

		return { goal };
	});

	// goal.list - List goals in room
	messageHub.onRequest('goal.list', async (data) => {
		const params = data as { roomId: string; status?: GoalStatus };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goals = await goalManager.listGoals(params.status);

		return { goals };
	});

	// goal.updateStatus - Update goal status
	messageHub.onRequest('goal.updateStatus', async (data) => {
		const params = data as {
			roomId: string;
			goalId: string;
			status: GoalStatus;
			updates?: Partial<RoomGoal>;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}
		if (!params.status) {
			throw new Error('Status is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.updateGoalStatus(params.goalId, params.status, params.updates);

		// Emit goal.updated event
		emitGoalUpdated(params.roomId, params.goalId, goal);

		return { goal };
	});

	// goal.updateProgress - Update goal progress
	messageHub.onRequest('goal.updateProgress', async (data) => {
		const params = data as {
			roomId: string;
			goalId: string;
			progress: number;
			metrics?: Record<string, number>;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}
		if (params.progress === undefined) {
			throw new Error('Progress is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.updateGoalProgress(
			params.goalId,
			params.progress,
			params.metrics
		);

		// Emit goal.progressUpdated event
		emitGoalProgressUpdated(params.roomId, params.goalId, goal.progress);

		return { goal };
	});

	// goal.updatePriority - Update goal priority
	messageHub.onRequest('goal.updatePriority', async (data) => {
		const params = data as { roomId: string; goalId: string; priority: GoalPriority };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}
		if (!params.priority) {
			throw new Error('Priority is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.updateGoalPriority(params.goalId, params.priority);

		// Emit goal.updated event
		emitGoalUpdated(params.roomId, params.goalId, goal);

		return { goal };
	});

	// goal.start - Start a goal (mark as in_progress)
	messageHub.onRequest('goal.start', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.startGoal(params.goalId);

		// Emit goal.updated event (status change from pending to in_progress)
		emitGoalUpdated(params.roomId, params.goalId, goal);

		return { goal };
	});

	// goal.complete - Complete a goal
	messageHub.onRequest('goal.complete', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.completeGoal(params.goalId);

		// Emit goal.completed event
		emitGoalCompleted(params.roomId, goal);

		return { goal };
	});

	// goal.block - Block a goal
	messageHub.onRequest('goal.block', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.blockGoal(params.goalId);

		// Emit goal.updated event (status change to blocked)
		emitGoalUpdated(params.roomId, params.goalId, goal);

		return { goal };
	});

	// goal.unblock - Unblock a goal (return to pending)
	messageHub.onRequest('goal.unblock', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.unblockGoal(params.goalId);

		// Emit goal.updated event (status change from blocked to pending)
		emitGoalUpdated(params.roomId, params.goalId, goal);

		return { goal };
	});

	// goal.linkTask - Link a task to a goal
	messageHub.onRequest('goal.linkTask', async (data) => {
		const params = data as { roomId: string; goalId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.linkTaskToGoal(params.goalId, params.taskId);

		// Emit goal.updated event (task linked and progress recalculated)
		emitGoalUpdated(params.roomId, params.goalId, goal);
		emitGoalProgressUpdated(params.roomId, params.goalId, goal.progress);

		return { goal };
	});

	// goal.unlinkTask - Unlink a task from a goal
	messageHub.onRequest('goal.unlinkTask', async (data) => {
		const params = data as { roomId: string; goalId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.unlinkTaskFromGoal(params.goalId, params.taskId);

		// Emit goal.updated event (task unlinked and progress recalculated)
		emitGoalUpdated(params.roomId, params.goalId, goal);
		emitGoalProgressUpdated(params.roomId, params.goalId, goal.progress);

		return { goal };
	});

	// goal.delete - Delete a goal
	messageHub.onRequest('goal.delete', async (data) => {
		const params = data as { roomId: string; goalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.goalId) {
			throw new Error('Goal ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const success = await goalManager.deleteGoal(params.goalId);

		// Emit goal.updated event with undefined goal to signal deletion
		emitGoalUpdated(params.roomId, params.goalId);

		return { success };
	});

	// goal.getNext - Get next goal to work on (by priority)
	messageHub.onRequest('goal.getNext', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goal = await goalManager.getNextGoal();

		return { goal };
	});

	// goal.getActive - Get all active goals (pending or in_progress)
	messageHub.onRequest('goal.getActive', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const goalManager = goalManagerFactory(params.roomId);
		const goals = await goalManager.getActiveGoals();

		return { goals };
	});
}
