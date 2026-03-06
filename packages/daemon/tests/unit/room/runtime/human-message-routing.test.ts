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
import type { MessageHub } from '@neokai/shared';

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

function makeMessageHub(): {
	messageHub: MessageHub;
	event: ReturnType<typeof mock>;
} {
	const event = mock(() => {});
	const messageHub = { event } as unknown as MessageHub;
	return { messageHub, event };
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
			// Content must be JSON-serialized so the frontend renderer can parse it
			// (renderer calls JSON.parse for all non-'status' message types).
			// Parse the content to verify structure (turnId includes a timestamp suffix).
			expect(appendMessage).toHaveBeenCalledTimes(1);
			const call = appendMessage.mock.calls[0][0] as {
				groupId: string;
				role: string;
				messageType: string;
				content: string;
			};
			expect(call.groupId).toBe('group-1');
			expect(call.role).toBe('human');
			expect(call.messageType).toBe('user');
			const parsed = JSON.parse(call.content) as {
				type: string;
				message: unknown;
				_taskMeta: {
					authorRole: string;
					authorSessionId: string;
					turnId: string;
					iteration: number;
				};
			};
			expect(parsed.type).toBe('user');
			expect(parsed.message).toEqual({
				role: 'user',
				content: [{ type: 'text', text: message }],
			});
			expect(parsed._taskMeta.authorRole).toBe('human');
			expect(parsed._taskMeta.authorSessionId).toBe('');
			expect(parsed._taskMeta.turnId).toMatch(/^human_group-1_0_[0-9a-f-]{36}$/);
			expect(parsed._taskMeta.iteration).toBe(0);
		});

		it('calls appendMessage exactly once', async () => {
			const { runtime } = makeRuntime(true, true);
			const { groupRepo, appendMessage } = makeGroupRepo(makeGroup('awaiting_leader'));

			await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(appendMessage).toHaveBeenCalledTimes(1);
		});

		it('emits state.groupMessages.delta on the group channel when messageHub is provided', async () => {
			const { runtime } = makeRuntime(true, true);
			const { groupRepo } = makeGroupRepo(makeGroup('awaiting_leader'));
			const { messageHub, event } = makeMessageHub();

			const result = await routeHumanMessageToGroup(
				runtime,
				groupRepo,
				taskId,
				message,
				messageHub
			);

			expect(result.success).toBe(true);
			expect(event).toHaveBeenCalledTimes(1);
			const [eventName, payload, options] = event.mock.calls[0] as [
				string,
				{ added: Array<{ type: string; _taskMeta: { authorRole: string } }>; timestamp: number },
				{ channel: string },
			];
			expect(eventName).toBe('state.groupMessages.delta');
			expect(options.channel).toBe('group:group-1');
			expect(Array.isArray(payload.added)).toBe(true);
			expect(payload.added).toHaveLength(1);
			expect(payload.added[0].type).toBe('user');
			expect(payload.added[0]._taskMeta.authorRole).toBe('human');
			expect(typeof payload.timestamp).toBe('number');
		});

		it('does not emit delta when messageHub is not provided', async () => {
			const { runtime } = makeRuntime(true, true);
			const { groupRepo } = makeGroupRepo(makeGroup('awaiting_leader'));

			// No messageHub argument — no event should be emitted, result still succeeds
			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(true);
		});

		it('returns success even when messageHub.event throws', async () => {
			const { runtime } = makeRuntime(true, true);
			const { groupRepo } = makeGroupRepo(makeGroup('awaiting_leader'));
			const event = mock(() => {
				throw new Error('hub closed');
			});
			const messageHub = { event } as unknown as MessageHub;

			const result = await routeHumanMessageToGroup(
				runtime,
				groupRepo,
				taskId,
				message,
				messageHub
			);

			// Broadcast failed but persist succeeded — RPC must not surface the error
			expect(result.success).toBe(true);
		});

		it('returns error and does not append when injectMessageToLeader fails (simulates catch path)', async () => {
			// injectMessageToLeader returns false when sessionFactory.injectMessage() throws
			// (the real method catches the error and returns false).
			// routeHumanMessageToGroup must propagate the failure and NOT call appendMessage.
			const { runtime } = makeRuntime(true, false);
			const { groupRepo, appendMessage } = makeGroupRepo(makeGroup('awaiting_leader'));

			const result = await routeHumanMessageToGroup(runtime, groupRepo, taskId, message);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to inject message into leader session');
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
