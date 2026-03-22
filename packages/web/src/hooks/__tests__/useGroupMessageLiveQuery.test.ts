/**
 * Unit tests for useGroupMessageLiveQuery hook
 *
 * Verifies that the hook:
 * - Subscribes to `sessionGroupMessages.byGroup` on mount with a unique subscriptionId
 * - Sets loading=true until the snapshot event arrives
 * - Replaces messages on liveQuery.snapshot
 * - Appends added messages on liveQuery.delta (ignores updated/removed)
 * - Discards snapshot/delta events from prior subscriptions (stale-subscriptionId guard)
 * - Calls liveQuery.unsubscribe on unmount
 * - Re-subscribes when groupId changes (unsubscribes old first)
 * - Handles null groupId: clears messages, does not subscribe
 * - Surfaces subscribe RPC errors via error state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/preact';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';
import { useGroupMessageLiveQuery, type GroupMessage } from '../useGroupMessageLiveQuery';

// -------------------------------------------------------
// Mock helpers
// -------------------------------------------------------

// Handlers captured per event name so tests can fire them
const snapshotHandlers: Array<(event: LiveQuerySnapshotEvent) => void> = [];
const deltaHandlers: Array<(event: LiveQueryDeltaEvent) => void> = [];

const mockRequest = vi.fn();
const mockOnEvent = vi.fn(
	(eventName: string, handler: (event: LiveQuerySnapshotEvent | LiveQueryDeltaEvent) => void) => {
		if (eventName === 'liveQuery.snapshot') {
			snapshotHandlers.push(handler as (e: LiveQuerySnapshotEvent) => void);
		} else if (eventName === 'liveQuery.delta') {
			deltaHandlers.push(handler as (e: LiveQueryDeltaEvent) => void);
		}
		// Return a no-op unsubscribe for simplicity; tests don't need to track these
		return () => {};
	}
);

vi.mock('../useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
	}),
}));

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeMessage(id: number, groupId = 'grp-1'): GroupMessage {
	return {
		id,
		groupId,
		sessionId: null,
		role: 'system',
		messageType: 'status',
		content: `message-${id}`,
		createdAt: 1000 + id,
	};
}

/** Fire a snapshot event to all registered snapshot handlers */
function fireSnapshot(subscriptionId: string, rows: GroupMessage[]): void {
	const event: LiveQuerySnapshotEvent = { subscriptionId, rows, version: 1 };
	for (const h of snapshotHandlers) {
		h(event);
	}
}

/** Fire a delta event to all registered delta handlers */
function fireDelta(subscriptionId: string, added?: GroupMessage[]): void {
	const event: LiveQueryDeltaEvent = {
		subscriptionId,
		added,
		version: 2,
	};
	for (const h of deltaHandlers) {
		h(event);
	}
}

/** Extract the subscriptionId from the most recent liveQuery.subscribe call */
function lastSubscribeId(): string {
	const calls = mockRequest.mock.calls;
	for (let i = calls.length - 1; i >= 0; i--) {
		const [method, data] = calls[i] as [string, { subscriptionId?: string }];
		if (method === 'liveQuery.subscribe') {
			return data.subscriptionId ?? '';
		}
	}
	return '';
}

// -------------------------------------------------------
// Setup / teardown
// -------------------------------------------------------

beforeEach(() => {
	snapshotHandlers.length = 0;
	deltaHandlers.length = 0;
	mockRequest.mockResolvedValue({ ok: true });
	mockOnEvent.mockClear();
	mockRequest.mockClear();
});

afterEach(() => {
	cleanup();
});

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('useGroupMessageLiveQuery', () => {
	it('calls liveQuery.subscribe on mount with correct params', async () => {
		renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith(
				'liveQuery.subscribe',
				expect.objectContaining({
					queryName: 'sessionGroupMessages.byGroup',
					params: ['grp-1'],
					subscriptionId: expect.any(String),
				})
			);
		});
	});

	it('registers snapshot and delta event listeners before subscribing', () => {
		renderHook(() => useGroupMessageLiveQuery('grp-1'));

		// onEvent should be called for both snapshot and delta
		const eventNames = mockOnEvent.mock.calls.map((args) => args[0] as string);
		expect(eventNames).toContain('liveQuery.snapshot');
		expect(eventNames).toContain('liveQuery.delta');
	});

	it('starts with loading=true', () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));
		expect(result.current.loading).toBe(true);
		expect(result.current.messages).toEqual([]);
	});

	it('replaces messages and clears loading on snapshot', async () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		act(() => {
			fireSnapshot(subId, [makeMessage(1), makeMessage(2)]);
		});

		expect(result.current.loading).toBe(false);
		expect(result.current.messages).toHaveLength(2);
		expect(result.current.messages[0].id).toBe(1);
		expect(result.current.messages[1].id).toBe(2);
	});

	it('appends added messages on delta', async () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		act(() => {
			fireSnapshot(subId, [makeMessage(1)]);
		});
		expect(result.current.messages).toHaveLength(1);

		act(() => {
			fireDelta(subId, [makeMessage(2), makeMessage(3)]);
		});

		expect(result.current.messages).toHaveLength(3);
		expect(result.current.messages[2].id).toBe(3);
	});

	it('ignores delta events with no added array', async () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		act(() => {
			fireSnapshot(subId, [makeMessage(1)]);
		});
		expect(result.current.messages).toHaveLength(1);

		act(() => {
			// Delta with only updated — append-only invariant, should be ignored
			const event: LiveQueryDeltaEvent = {
				subscriptionId: subId,
				updated: [makeMessage(1)],
				version: 2,
			};
			for (const h of deltaHandlers) h(event);
		});

		// Messages should be unchanged
		expect(result.current.messages).toHaveLength(1);
	});

	it('discards snapshot from a stale subscriptionId (stale-event guard)', async () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const currentSubId = lastSubscribeId();

		act(() => {
			// Fire snapshot with a different, "stale" subscriptionId
			fireSnapshot('stale-sub-id-000', [makeMessage(99)]);
		});

		// Messages should remain empty; loading still true
		expect(result.current.messages).toHaveLength(0);
		expect(result.current.loading).toBe(true);

		// The real snapshot arrives
		act(() => {
			fireSnapshot(currentSubId, [makeMessage(1)]);
		});

		expect(result.current.messages).toHaveLength(1);
		expect(result.current.loading).toBe(false);
	});

	it('discards delta from a stale subscriptionId (stale-event guard)', async () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		act(() => {
			fireSnapshot(subId, [makeMessage(1)]);
		});
		expect(result.current.messages).toHaveLength(1);

		act(() => {
			// Delta with stale subscriptionId — should be discarded
			fireDelta('stale-sub-id-000', [makeMessage(2)]);
		});

		expect(result.current.messages).toHaveLength(1);
	});

	it('calls liveQuery.unsubscribe on unmount', async () => {
		const { result, unmount } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		mockRequest.mockClear();
		act(() => unmount());

		expect(mockRequest).toHaveBeenCalledWith('liveQuery.unsubscribe', { subscriptionId: subId });
	});

	it('unsubscribes old and subscribes new when groupId changes', async () => {
		const { result, rerender } = renderHook(
			({ groupId }: { groupId: string }) => useGroupMessageLiveQuery(groupId),
			{ initialProps: { groupId: 'grp-1' } }
		);

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('liveQuery.subscribe', expect.any(Object))
		);
		const firstSubId = lastSubscribeId();

		mockRequest.mockClear();

		act(() => {
			rerender({ groupId: 'grp-2' });
		});

		await waitFor(() => {
			// Old subscription should be cleaned up
			expect(mockRequest).toHaveBeenCalledWith('liveQuery.unsubscribe', {
				subscriptionId: firstSubId,
			});
			// New subscription should be created
			expect(mockRequest).toHaveBeenCalledWith(
				'liveQuery.subscribe',
				expect.objectContaining({
					queryName: 'sessionGroupMessages.byGroup',
					params: ['grp-2'],
					subscriptionId: expect.any(String),
				})
			);
		});

		// The new subscriptionId must differ from the old one
		const newSubId = lastSubscribeId();
		expect(newSubId).not.toBe(firstSubId);
	});

	it('clears messages and does not subscribe when groupId is null', () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery(null));

		expect(result.current.messages).toEqual([]);
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();

		// No subscribe call should have been made
		expect(mockRequest).not.toHaveBeenCalledWith('liveQuery.subscribe', expect.any(Object));
	});

	it('clears messages when groupId changes to null', async () => {
		const { result, rerender } = renderHook(
			({ groupId }: { groupId: string | null }) => useGroupMessageLiveQuery(groupId),
			{ initialProps: { groupId: 'grp-1' as string | null } }
		);

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		act(() => {
			fireSnapshot(subId, [makeMessage(1), makeMessage(2)]);
		});
		expect(result.current.messages).toHaveLength(2);

		mockRequest.mockClear();
		act(() => {
			rerender({ groupId: null });
		});

		expect(result.current.messages).toEqual([]);
		expect(result.current.loading).toBe(false);
		// Old subscription unsubscribed
		expect(mockRequest).toHaveBeenCalledWith('liveQuery.unsubscribe', { subscriptionId: subId });
	});

	it('sets error and clears loading when liveQuery.subscribe fails', async () => {
		mockRequest.mockImplementation((method: string) => {
			if (method === 'liveQuery.subscribe') {
				return Promise.reject(new Error('Auth denied'));
			}
			return Promise.resolve({ ok: true });
		});

		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
			expect(result.current.error).toBe('Auth denied');
		});
	});

	it('resets messages and loading=true when groupId changes', async () => {
		const { result, rerender } = renderHook(
			({ groupId }: { groupId: string }) => useGroupMessageLiveQuery(groupId),
			{ initialProps: { groupId: 'grp-1' } }
		);

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		act(() => {
			fireSnapshot(subId, [makeMessage(1), makeMessage(2)]);
		});
		expect(result.current.messages).toHaveLength(2);
		expect(result.current.loading).toBe(false);

		// Switch to a new group — messages should reset and loading restart
		act(() => {
			rerender({ groupId: 'grp-2' });
		});

		expect(result.current.messages).toEqual([]);
		expect(result.current.loading).toBe(true);
	});

	it('uses unique subscriptionIds for each subscription', async () => {
		const { rerender } = renderHook(
			({ groupId }: { groupId: string }) => useGroupMessageLiveQuery(groupId),
			{ initialProps: { groupId: 'grp-1' } }
		);

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const firstSubId = lastSubscribeId();

		act(() => {
			rerender({ groupId: 'grp-2' });
		});

		await waitFor(() => {
			const calls = mockRequest.mock.calls.filter((args) => args[0] === 'liveQuery.subscribe');
			expect(calls.length).toBeGreaterThanOrEqual(2);
		});
		const secondSubId = lastSubscribeId();

		expect(firstSubId).not.toBe('');
		expect(secondSubId).not.toBe('');
		expect(firstSubId).not.toBe(secondSubId);
	});
});
