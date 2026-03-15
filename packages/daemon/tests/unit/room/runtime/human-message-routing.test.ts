/**
 * Tests for routeHumanMessageToGroup
 *
 * Routing behavior:
 * - Active groups (completedAt = null): messages injected directly into worker or leader
 * - Terminated groups (completedAt set): messages are blocked regardless of task status
 *   (callers must pre-process via reviveTaskForMessage or set_task_status)
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

function makeRuntime(injectResult = true): {
	runtime: RoomRuntime;
	injectMessageToLeader: ReturnType<typeof mock>;
	injectMessageToWorker: ReturnType<typeof mock>;
} {
	const injectMessageToLeader = mock(async () => injectResult);
	const injectMessageToWorker = mock(async () => injectResult);

	const runtime = {
		injectMessageToLeader,
		injectMessageToWorker,
	} as unknown as RoomRuntime;

	return { runtime, injectMessageToLeader, injectMessageToWorker };
}

function makeTaskOperator(task: NeoTask | null = null) {
	return {
		getTask: mock(async () => task),
		setTaskStatus: mock(async () => undefined),
	};
}

function makeGroupRepo(group: SessionGroup | null): {
	groupRepo: SessionGroupRepository;
} {
	const groupRepo = {
		getGroupByTaskId: mock(() => group),
	} as unknown as SessionGroupRepository;

	return { groupRepo };
}

describe('routeHumanMessageToGroup', () => {
	const taskId = 'task-1';
	const message = 'Hello from human';

	describe('active group (completedAt = null)', () => {
		describe('target=worker (default)', () => {
			it('injects to worker and returns success', async () => {
				const { runtime, injectMessageToWorker } = makeRuntime(true);
				const taskManager = makeTaskOperator(makeTask('in_progress'));
				const { groupRepo } = makeGroupRepo(makeGroup(null));

				const result = await routeHumanMessageToGroup(
					runtime,
					groupRepo,
					taskManager,
					taskId,
					message
				);

				expect(result.success).toBe(true);
				expect(injectMessageToWorker).toHaveBeenCalledWith(taskId, message);
			});

			it('returns error when injectMessageToWorker fails', async () => {
				const { runtime } = makeRuntime(false);
				const taskManager = makeTaskOperator(makeTask('in_progress'));
				const { groupRepo } = makeGroupRepo(makeGroup(null));

				const result = await routeHumanMessageToGroup(
					runtime,
					groupRepo,
					taskManager,
					taskId,
					message
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Failed to inject message into worker session');
			});
		});

		describe('target=leader', () => {
			it('injects to leader and returns success', async () => {
				const { runtime, injectMessageToLeader } = makeRuntime(true);
				const taskManager = makeTaskOperator(makeTask('in_progress'));
				const { groupRepo } = makeGroupRepo(makeGroup(null));

				const result = await routeHumanMessageToGroup(
					runtime,
					groupRepo,
					taskManager,
					taskId,
					message,
					'leader'
				);

				expect(result.success).toBe(true);
				expect(injectMessageToLeader).toHaveBeenCalledWith(taskId, message);
			});

			it('returns error when injectMessageToLeader fails', async () => {
				const { runtime } = makeRuntime(false);
				const taskManager = makeTaskOperator(makeTask('in_progress'));
				const { groupRepo } = makeGroupRepo(makeGroup(null));

				const result = await routeHumanMessageToGroup(
					runtime,
					groupRepo,
					taskManager,
					taskId,
					message,
					'leader'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Failed to inject message into leader session');
			});
		});
	});

	describe('terminated group (completedAt set)', () => {
		it.each([
			['needs_attention'],
			['cancelled'],
			['completed'],
		])('blocks messages when task status is %s', async (status) => {
			const { runtime, injectMessageToWorker } = makeRuntime(true);
			const taskManager = makeTaskOperator(makeTask(status));
			const { groupRepo } = makeGroupRepo(makeGroup(Date.now()));

			const result = await routeHumanMessageToGroup(
				runtime,
				groupRepo,
				taskManager,
				taskId,
				message
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain(`'${status}'`);
			expect(injectMessageToWorker).not.toHaveBeenCalled();
			expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
		});

		it('returns error with terminated-state message when task not found', async () => {
			const { runtime, injectMessageToWorker } = makeRuntime(true);
			const taskManager = makeTaskOperator(null);
			const { groupRepo } = makeGroupRepo(makeGroup(Date.now()));

			const result = await routeHumanMessageToGroup(
				runtime,
				groupRepo,
				taskManager,
				taskId,
				message
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('terminated state');
			expect(injectMessageToWorker).not.toHaveBeenCalled();
		});
	});

	describe('no group', () => {
		it('returns failure when no group is found', async () => {
			const { runtime } = makeRuntime(true);
			const taskManager = makeTaskOperator(makeTask('in_progress'));
			const { groupRepo } = makeGroupRepo(null);

			const result = await routeHumanMessageToGroup(
				runtime,
				groupRepo,
				taskManager,
				taskId,
				message
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('No active session group');
		});
	});
});
