/**
 * Tests for routeHumanMessageToGroup
 *
 * Routing behavior:
 * - Active groups (completedAt = null): messages injected directly
 * - Failed/cancelled tasks: group is reset and task transitions to in_progress
 * - Completed tasks: message is blocked
 */

import { describe, expect, it, mock } from 'bun:test';
import { routeHumanMessageToGroup } from '../../../../src/lib/room/runtime/human-message-routing';
import type { RoomRuntime } from '../../../../src/lib/room/runtime/room-runtime';
import type {
	SessionGroupRepository,
	SessionGroup,
} from '../../../../src/lib/room/state/session-group-repository';
import type { NeoTask } from '@neokai/shared';

function makeGroup(completedAt: number | null): SessionGroup {
	return {
		id: 'group-1',
		taskId: 'task-1',
		groupType: 'task',
		workerSessionId: 'worker-session',
		leaderSessionId: 'leader-session',
		workerRole: 'coder',
		feedbackIteration: 0,
		approved: false,
		leaderContractViolations: 0,
		leaderCalledTool: false,
		lastProcessedLeaderTurnId: null,
		lastForwardedMessageId: null,
		activeWorkStartedAt: null,
		activeWorkElapsed: 0,
		hibernatedAt: null,
		version: 1,
		tokensUsed: 0,
		submittedForReview: false,
		createdAt: Date.now(),
		completedAt,
	};
}

function makeTask(status: string): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		description: '',
		status: status as NeoTask['status'],
		priority: 'normal',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		result: null,
		error: null,
		dependsOn: [],
		dependsOnMet: true,
		dependsOnCount: 0,
		metadata: null,
	};
}

function makeRuntime(
	injectResult = true,
	task?: NeoTask | null
): {
	runtime: RoomRuntime;
	injectMessageToLeader: ReturnType<typeof mock>;
	injectMessageToWorker: ReturnType<typeof mock>;
	taskManager: {
		getTask: ReturnType<typeof mock>;
		updateTaskStatus: ReturnType<typeof mock>;
	};
} {
	const injectMessageToLeader = mock(async () => injectResult);
	const injectMessageToWorker = mock(async () => injectResult);
	const getTask = mock(async () => task ?? null);
	const updateTaskStatus = mock(async () => undefined);

	const taskManager = {
		getTask,
		updateTaskStatus,
	};

	const runtime = {
		injectMessageToLeader,
		injectMessageToWorker,
		taskManager,
	} as unknown as RoomRuntime;

	return { runtime, injectMessageToLeader, injectMessageToWorker, taskManager };
}

function makeGroupRepo(
	group: SessionGroup | null,
	resetGroupForRestartResult = true
): {
	groupRepo: SessionGroupRepository;
	getGroupByTaskId: ReturnType<typeof mock>;
	resetGroupForRestart: ReturnType<typeof mock>;
	failGroup: ReturnType<typeof mock>;
	failGroupCalls: { groupId: string; version: number }[];
} {
	const getGroupByTaskId = mock(() => group);
	const resetGroupForRestart = mock(() => (resetGroupForRestartResult ? group : null));
	const failGroupCalls: { groupId: string; version: number }[] = [];
	const failGroup = mock((groupId: string, version: number) => {
		failGroupCalls.push({ groupId, version });
		return group;
	});

	const groupRepo = {
		getGroupByTaskId,
		resetGroupForRestart,
		failGroup,
	} as unknown as SessionGroupRepository;

	return { groupRepo, getGroupByTaskId, resetGroupForRestart, failGroup, failGroupCalls };
}

describe('routeHumanMessageToGroup', () => {
	const taskId = 'task-1';
	const message = 'Hello from human';

	describe('active group (completedAt = null)', () => {
		describe('target=worker (default)', () => {
			it('injects to worker and returns success', async () => {
				const { runtime, injectMessageToWorker } = makeRuntime(true, makeTask('in_progress'));
				const { groupRepo } = makeGroupRepo(makeGroup(null));

				const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

				expect(result.success).toBe(true);
				expect(injectMessageToWorker).toHaveBeenCalledWith(taskId, message);
			});

			it('returns error when injectMessageToWorker fails', async () => {
				const { runtime } = makeRuntime(false, makeTask('in_progress'));
				const { groupRepo } = makeGroupRepo(makeGroup(null));

				const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Failed to inject message into worker session');
			});
		});

		describe('target=leader', () => {
			it('injects to leader and returns success', async () => {
				const { runtime, injectMessageToLeader } = makeRuntime(true, makeTask('in_progress'));
				const { groupRepo } = makeGroupRepo(makeGroup(null));

				const result = await routeHumanMessageToGroup(
					runtime,
					groupRepo,
					taskId,
					message,
					'leader'
				);

				expect(result.success).toBe(true);
				expect(injectMessageToLeader).toHaveBeenCalledWith(taskId, message);
			});

			it('returns error when injectMessageToLeader fails', async () => {
				const { runtime } = makeRuntime(false, makeTask('in_progress'));
				const { groupRepo } = makeGroupRepo(makeGroup(null));

				const result = await routeHumanMessageToGroup(
					runtime,
					groupRepo,
					taskId,
					message,
					'leader'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Failed to inject message into leader session');
			});
		});
	});

	describe('failed task (completedAt set, task status = failed)', () => {
		it('resets group, transitions to in_progress, and injects message', async () => {
			const failedTask = makeTask('failed');
			const { runtime, injectMessageToWorker, taskManager } = makeRuntime(true, failedTask);
			const { groupRepo, resetGroupForRestart } = makeGroupRepo(makeGroup(Date.now()), true);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(true);
			expect(resetGroupForRestart).toHaveBeenCalledWith('group-1');
			expect(taskManager.updateTaskStatus).toHaveBeenCalledWith(taskId, 'in_progress');
			expect(injectMessageToWorker).toHaveBeenCalledWith(taskId, message);
		});

		it('returns error when resetGroupForRestart fails', async () => {
			const failedTask = makeTask('failed');
			const { runtime, taskManager } = makeRuntime(true, failedTask);
			const { groupRepo, resetGroupForRestart } = makeGroupRepo(makeGroup(Date.now()), false);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to reset task group');
			expect(taskManager.updateTaskStatus).not.toHaveBeenCalled();
		});

		it('returns error when updateTaskStatus fails', async () => {
			const failedTask = makeTask('failed');
			const { runtime, injectMessageToWorker, taskManager } = makeRuntime(true, failedTask);
			taskManager.updateTaskStatus = mock(async () => {
				throw new Error('Status update failed');
			});
			// Group version is 1, so rollback should use version 2 (previousVersion + 1)
			const group = makeGroup(Date.now());
			group.version = 1;
			const { groupRepo, failGroup, failGroupCalls } = makeGroupRepo(group, true);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to transition task to in_progress');
			expect(injectMessageToWorker).not.toHaveBeenCalled();
			// Should have rolled back the group state with correct version (1 + 1 = 2)
			expect(failGroup).toHaveBeenCalled();
			expect(failGroupCalls).toEqual([{ groupId: 'group-1', version: 2 }]);
		});

		it('rolls back status and group when message injection fails', async () => {
			const failedTask = makeTask('failed');
			// injectResult = false to simulate injection failure
			const { runtime, injectMessageToWorker, taskManager } = makeRuntime(false, failedTask);
			// Group version is 1, so rollback should use version 2 (previousVersion + 1)
			const group = makeGroup(Date.now());
			group.version = 1;
			const { groupRepo, resetGroupForRestart, failGroup, failGroupCalls } = makeGroupRepo(
				group,
				true
			);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to inject message');
			// Group was reset
			expect(resetGroupForRestart).toHaveBeenCalledWith('group-1');
			// Status was changed to in_progress
			expect(taskManager.updateTaskStatus).toHaveBeenCalledWith(taskId, 'in_progress');
			// Tried to inject
			expect(injectMessageToWorker).toHaveBeenCalledWith(taskId, message);
			// Rolled back to failed with correct version (1 + 1 = 2)
			expect(failGroup).toHaveBeenCalled();
			expect(failGroupCalls).toEqual([{ groupId: 'group-1', version: 2 }]);
			// Status rolled back to failed
			expect(taskManager.updateTaskStatus).toHaveBeenCalledWith(taskId, 'failed');
		});
	});

	describe('cancelled task (completedAt set, task status = cancelled)', () => {
		it('resets group, transitions to in_progress, and injects message', async () => {
			const cancelledTask = makeTask('cancelled');
			const { runtime, injectMessageToWorker, taskManager } = makeRuntime(true, cancelledTask);
			const { groupRepo, resetGroupForRestart } = makeGroupRepo(makeGroup(Date.now()), true);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(true);
			expect(resetGroupForRestart).toHaveBeenCalledWith('group-1');
			expect(taskManager.updateTaskStatus).toHaveBeenCalledWith(taskId, 'in_progress');
			expect(injectMessageToWorker).toHaveBeenCalledWith(taskId, message);
		});
	});

	describe('completed task (completedAt set, task status = completed)', () => {
		it('returns failure - completed tasks cannot be restarted', async () => {
			const completedTask = makeTask('completed');
			const { runtime, injectMessageToWorker, taskManager } = makeRuntime(true, completedTask);
			const { groupRepo } = makeGroupRepo(makeGroup(Date.now()), true);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Task is already completed');
			expect(taskManager.updateTaskStatus).not.toHaveBeenCalled();
			expect(injectMessageToWorker).not.toHaveBeenCalled();
		});
	});

	describe('no task found (completedAt set)', () => {
		it('returns failure when task not found', async () => {
			const { runtime, injectMessageToWorker, taskManager } = makeRuntime(true, null);
			const { groupRepo } = makeGroupRepo(makeGroup(Date.now()), true);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Task not found');
			expect(taskManager.updateTaskStatus).not.toHaveBeenCalled();
			expect(injectMessageToWorker).not.toHaveBeenCalled();
		});
	});

	describe('no group', () => {
		it('returns failure when no group is found', async () => {
			const { runtime } = makeRuntime(true, makeTask('in_progress'));
			const { groupRepo } = makeGroupRepo(null);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('No active session group');
		});
	});
});
