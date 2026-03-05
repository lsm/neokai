/**
 * Tests for routeHumanMessageToGroup
 *
 * Covers all session group state branches:
 * - awaiting_human  → calls resumeWorkerFromHuman, no appendMessage
 * - awaiting_leader → calls injectMessageToLeader + appendMessage
 * - awaiting_worker → returns error
 * - completed       → returns error
 * - failed          → returns error
 * - no group        → returns error
 */

import { describe, expect, it, mock } from 'bun:test';
import { routeHumanMessageToGroup } from '../../../../src/lib/room/runtime/human-message-routing';
import type { RoomRuntime } from '../../../../src/lib/room/runtime/room-runtime';
import type {
	SessionGroupRepository,
	SessionGroup,
	GroupState,
} from '../../../../src/lib/room/state/session-group-repository';

function makeGroup(state: GroupState): SessionGroup {
	return {
		id: 'group-1',
		taskId: 'task-1',
		groupType: 'task',
		workerSessionId: 'worker-session',
		leaderSessionId: 'leader-session',
		workerRole: 'coder',
		state,
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
		completedAt: null,
	};
}

function makeRuntime(
	resumeResult = true,
	injectResult = true
): {
	runtime: RoomRuntime;
	resumeWorkerFromHuman: ReturnType<typeof mock>;
	injectMessageToLeader: ReturnType<typeof mock>;
} {
	const resumeWorkerFromHuman = mock(async () => resumeResult);
	const injectMessageToLeader = mock(async () => injectResult);

	const runtime = {
		resumeWorkerFromHuman,
		injectMessageToLeader,
	} as unknown as RoomRuntime;

	return { runtime, resumeWorkerFromHuman, injectMessageToLeader };
}

function makeGroupRepo(group: SessionGroup | null): {
	groupRepo: SessionGroupRepository;
	getGroupByTaskId: ReturnType<typeof mock>;
	appendMessage: ReturnType<typeof mock>;
} {
	const getGroupByTaskId = mock(() => group);
	const appendMessage = mock(() => 1);

	const groupRepo = {
		getGroupByTaskId,
		appendMessage,
	} as unknown as SessionGroupRepository;

	return { groupRepo, getGroupByTaskId, appendMessage };
}

describe('routeHumanMessageToGroup', () => {
	const taskId = 'task-1';
	const message = 'Hello from human';

	describe('awaiting_human state', () => {
		it('calls resumeWorkerFromHuman with approved=false and returns success', async () => {
			const { runtime, resumeWorkerFromHuman } = makeRuntime(true);
			const { groupRepo, appendMessage } = makeGroupRepo(makeGroup('awaiting_human'));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(true);
			expect(resumeWorkerFromHuman).toHaveBeenCalledWith(taskId, message, { approved: false });
			// appendMessage must NOT be called — resumeWorkerFromHuman handles it internally
			expect(appendMessage).not.toHaveBeenCalled();
		});

		it('returns error when resumeWorkerFromHuman returns false', async () => {
			const { runtime } = makeRuntime(false);
			const { groupRepo } = makeGroupRepo(makeGroup('awaiting_human'));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe('awaiting_leader state', () => {
		it('calls injectMessageToLeader and appends to timeline on success', async () => {
			const { runtime, injectMessageToLeader } = makeRuntime(true, true);
			const { groupRepo, appendMessage } = makeGroupRepo(makeGroup('awaiting_leader'));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(true);
			expect(injectMessageToLeader).toHaveBeenCalledWith(taskId, message);
			expect(appendMessage).toHaveBeenCalledWith({
				groupId: 'group-1',
				role: 'human',
				messageType: 'human',
				content: message,
			});
		});

		it('calls appendMessage exactly once', async () => {
			const { runtime } = makeRuntime(true, true);
			const { groupRepo, appendMessage } = makeGroupRepo(makeGroup('awaiting_leader'));

			await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(appendMessage).toHaveBeenCalledTimes(1);
		});

		it('returns error when injectMessageToLeader returns false', async () => {
			const { runtime } = makeRuntime(true, false);
			const { groupRepo, appendMessage } = makeGroupRepo(makeGroup('awaiting_leader'));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			expect(appendMessage).not.toHaveBeenCalled();
		});
	});

	describe('awaiting_worker state', () => {
		it('returns failure with descriptive error', async () => {
			const { runtime } = makeRuntime();
			const { groupRepo } = makeGroupRepo(makeGroup('awaiting_worker'));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Worker is running');
		});
	});

	describe('completed state', () => {
		it('returns failure with completed error', async () => {
			const { runtime } = makeRuntime();
			const { groupRepo } = makeGroupRepo(makeGroup('completed'));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('completed');
		});
	});

	describe('failed state', () => {
		it('returns failure with failed error', async () => {
			const { runtime } = makeRuntime();
			const { groupRepo } = makeGroupRepo(makeGroup('failed'));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('failed');
		});
	});

	describe('no group', () => {
		it('returns failure when no group is found', async () => {
			const { runtime } = makeRuntime();
			const { groupRepo } = makeGroupRepo(null);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('No active session group');
		});
	});
});
