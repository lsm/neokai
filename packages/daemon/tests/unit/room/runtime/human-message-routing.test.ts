/**
 * Tests for routeHumanMessageToGroup
 *
 * Simplified routing: Messages can be sent to worker or leader at any time.
 * Only fails if no group or group is completed (completedAt !== null).
 */

import { describe, expect, it, mock } from 'bun:test';
import { routeHumanMessageToGroup } from '../../../../src/lib/room/runtime/human-message-routing';
import type { RoomRuntime } from '../../../../src/lib/room/runtime/room-runtime';
import type {
	SessionGroupRepository,
	SessionGroup,
} from '../../../../src/lib/room/state/session-group-repository';

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

function makeRuntime(
	resumeResult = true,
	injectResult = true
): {
	runtime: RoomRuntime;
	resumeWorkerFromHuman: ReturnType<typeof mock>;
	injectMessageToLeader: ReturnType<typeof mock>;
	injectMessageToWorker: ReturnType<typeof mock>;
} {
	const resumeWorkerFromHuman = mock(async () => resumeResult);
	const injectMessageToLeader = mock(async () => injectResult);
	const injectMessageToWorker = mock(async () => injectResult);

	const runtime = {
		resumeWorkerFromHuman,
		injectMessageToLeader,
		injectMessageToWorker,
	} as unknown as RoomRuntime;

	return { runtime, resumeWorkerFromHuman, injectMessageToLeader, injectMessageToWorker };
}

function makeGroupRepo(group: SessionGroup | null): {
	groupRepo: SessionGroupRepository;
	getGroupByTaskId: ReturnType<typeof mock>;
} {
	const getGroupByTaskId = mock(() => group);

	const groupRepo = {
		getGroupByTaskId,
	} as unknown as SessionGroupRepository;

	return { groupRepo, getGroupByTaskId };
}

describe('routeHumanMessageToGroup', () => {
	const taskId = 'task-1';
	const message = 'Hello from human';

	describe('target=worker (default)', () => {
		it('injects to worker and returns success', async () => {
			const { runtime, injectMessageToWorker } = makeRuntime(true, true);
			const { groupRepo } = makeGroupRepo(makeGroup(null));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(true);
			expect(injectMessageToWorker).toHaveBeenCalledWith(taskId, message);
		});

		it('returns error when injectMessageToWorker fails', async () => {
			const { runtime } = makeRuntime(true, false);
			const { groupRepo } = makeGroupRepo(makeGroup(null));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to inject message into worker session');
		});
	});

	describe('target=leader', () => {
		it('injects to leader and returns success', async () => {
			const { runtime, injectMessageToLeader } = makeRuntime(true, true);
			const { groupRepo } = makeGroupRepo(makeGroup(null));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message, 'leader');

			expect(result.success).toBe(true);
			expect(injectMessageToLeader).toHaveBeenCalledWith(taskId, message);
		});

		it('returns error when injectMessageToLeader fails', async () => {
			const { runtime } = makeRuntime(true, false);
			const { groupRepo } = makeGroupRepo(makeGroup(null));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message, 'leader');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to inject message into leader session');
		});
	});

	describe('completed group', () => {
		it('returns failure when group has completedAt set', async () => {
			const { runtime } = makeRuntime();
			const { groupRepo } = makeGroupRepo(makeGroup(Date.now()));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('completed');
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
