/**
 * Tests for routeHumanMessageToGroup
 *
 * Routing behavior:
 * - Active groups exist (completedAt = null): messages injected directly into worker or leader
 * - No active groups: returns "No active session group" error regardless of task status
 *   (callers must pre-process via reviveTaskForMessage before calling this function)
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

function makeGroupRepo(activeGroups: SessionGroup[]): {
	groupRepo: SessionGroupRepository;
} {
	const groupRepo = {
		getActiveGroupsForTask: mock(() => activeGroups),
	} as unknown as SessionGroupRepository;

	return { groupRepo };
}

describe('routeHumanMessageToGroup', () => {
	const taskId = 'task-1';
	const message = 'Hello from human';

	describe('active group exists (completedAt = null)', () => {
		describe('target=worker (default)', () => {
			it('injects to worker and returns success', async () => {
				const { runtime, injectMessageToWorker } = makeRuntime(true);
				const { groupRepo } = makeGroupRepo([makeGroup(null)]);

				const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

				expect(result.success).toBe(true);
				expect(injectMessageToWorker).toHaveBeenCalledWith(taskId, message);
			});

			it('returns error when injectMessageToWorker fails', async () => {
				const { runtime } = makeRuntime(false);
				const { groupRepo } = makeGroupRepo([makeGroup(null)]);

				const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Failed to inject message into worker session');
			});
		});

		describe('target=leader', () => {
			it('injects to leader and returns success', async () => {
				const { runtime, injectMessageToLeader } = makeRuntime(true);
				const { groupRepo } = makeGroupRepo([makeGroup(null)]);

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
				const { runtime } = makeRuntime(false);
				const { groupRepo } = makeGroupRepo([makeGroup(null)]);

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

	describe('no active group (empty list or all terminated)', () => {
		it('returns "No active session group" when getActiveGroupsForTask returns empty array', async () => {
			const { runtime, injectMessageToWorker } = makeRuntime(true);
			const { groupRepo } = makeGroupRepo([]);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('No active session group');
			expect(injectMessageToWorker).not.toHaveBeenCalled();
		});

		it('returns "No active session group" error — callers must revive before routing', async () => {
			// Simulates the bug scenario: task is in_progress but setStatus was used to transition it
			// without creating a new group. getActiveGroupsForTask returns [] (only non-null groups).
			const { runtime, injectMessageToWorker } = makeRuntime(true);
			const { groupRepo } = makeGroupRepo([]);

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('No active session group');
			expect(injectMessageToWorker).not.toHaveBeenCalled();
		});
	});
});
