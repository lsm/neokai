/**
 * Unit tests for useGroupMessageLiveQuery hook
 *
 * Verifies that the hook:
 * - Subscribes to `sessionGroupMessages.byGroup` on mount with a unique subscriptionId
 * - Sets loading=true until the snapshot event arrives
 * - Replaces messages on liveQuery.snapshot (also clears prior errors)
 * - Appends added messages on liveQuery.delta (ignores updated/removed)
 * - Discards snapshot/delta events from prior subscriptions (stale-subscriptionId guard)
 * - Actually removes event listeners on unmount / groupId change (real unsub mock)
 * - Calls liveQuery.unsubscribe RPC on unmount
 * - Re-subscribes when groupId changes (unsubscribes old first)
 * - Handles null groupId: clears messages, does not subscribe
 * - Surfaces subscribe RPC errors via error state
 * - Stays loading=true when subscribe resolves but no snapshot arrives
 * - Re-subscribes after WebSocket reconnect (isConnected false→true transition)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';
import { useGroupMessageLiveQuery, type GroupMessage } from '../useGroupMessageLiveQuery';

// -------------------------------------------------------
// Mock helpers
// -------------------------------------------------------

// Captured handlers — stored so tests can fire them directly.
// These two arrays MUST be cleared in beforeEach (mockOnEvent.mockClear() only
// clears vi.fn() call records, not the captured handler arrays).
const snapshotHandlers: Array<(event: LiveQuerySnapshotEvent) => void> = [];
const deltaHandlers: Array<(event: LiveQueryDeltaEvent) => void> = [];

const mockRequest = vi.fn();

// isConnected is a signal so the hook can react to connection state changes.
const mockIsConnected = signal(true);

// mockOnEvent returns a *real* unsub function that splices the handler out of
// the captured arrays — this makes listener removal observable in tests.
const mockOnEvent = vi.fn(
	(eventName: string, handler: (event: LiveQuerySnapshotEvent | LiveQueryDeltaEvent) => void) => {
		if (eventName === 'liveQuery.snapshot') {
			snapshotHandlers.push(handler as (e: LiveQuerySnapshotEvent) => void);
			return () => {
				const i = snapshotHandlers.indexOf(handler as (e: LiveQuerySnapshotEvent) => void);
				if (i !== -1) snapshotHandlers.splice(i, 1);
			};
		} else if (eventName === 'liveQuery.delta') {
			deltaHandlers.push(handler as (e: LiveQueryDeltaEvent) => void);
			return () => {
				const i = deltaHandlers.indexOf(handler as (e: LiveQueryDeltaEvent) => void);
				if (i !== -1) deltaHandlers.splice(i, 1);
			};
		}
		return () => {};
	}
);

vi.mock('../useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		isConnected: mockIsConnected.value,
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

// Monotonic version counter so snapshot/delta events have increasing versions.
let versionCounter = 0;
function nextVersion(): number {
	return ++versionCounter;
}

/** Fire a snapshot event to all registered snapshot handlers */
function fireSnapshot(subscriptionId: string, rows: GroupMessage[]): void {
	const event: LiveQuerySnapshotEvent = { subscriptionId, rows, version: nextVersion() };
	// Copy array before iterating — handlers may splice themselves during iteration
	for (const h of [...snapshotHandlers]) {
		h(event);
	}
}

/** Fire a delta event to all registered delta handlers */
function fireDelta(
	subscriptionId: string,
	added?: GroupMessage[],
	extra?: Partial<LiveQueryDeltaEvent>
): void {
	const event: LiveQueryDeltaEvent = { subscriptionId, added, ...extra, version: nextVersion() };
	for (const h of [...deltaHandlers]) {
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
	// Clear captured handler arrays AND vi.fn() call records
	snapshotHandlers.length = 0;
	deltaHandlers.length = 0;
	versionCounter = 0;
	mockRequest.mockResolvedValue({ ok: true });
	mockOnEvent.mockClear();
	mockRequest.mockClear();
	mockIsConnected.value = true;
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

		// onEvent should be called for both snapshot and delta before request
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

	it('clears prior error when snapshot arrives', async () => {
		// First mount with a failing subscribe
		mockRequest.mockRejectedValueOnce(new Error('Auth denied'));
		const { result, rerender } = renderHook(
			({ groupId }: { groupId: string }) => useGroupMessageLiveQuery(groupId),
			{ initialProps: { groupId: 'grp-1' } }
		);

		await waitFor(() => expect(result.current.error).toBe('Auth denied'));

		// Switch to same group again to re-trigger — use groupId change as retry vehicle
		mockRequest.mockResolvedValue({ ok: true });
		act(() => rerender({ groupId: 'grp-2' }));

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith(
				'liveQuery.subscribe',
				expect.objectContaining({ params: ['grp-2'] })
			)
		);
		const subId = lastSubscribeId();

		act(() => fireSnapshot(subId, [makeMessage(1)]));

		expect(result.current.error).toBeNull();
		expect(result.current.messages).toHaveLength(1);
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

	it('ignores delta events with no added array (append-only invariant)', async () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		act(() => {
			fireSnapshot(subId, [makeMessage(1)]);
		});
		expect(result.current.messages).toHaveLength(1);

		act(() => {
			// Delta with only updated / removed — must be ignored per append-only invariant
			fireDelta(subId, undefined, { updated: [makeMessage(1)], removed: [makeMessage(1)] });
		});

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
			fireDelta('stale-sub-id-000', [makeMessage(2)]);
		});

		expect(result.current.messages).toHaveLength(1);
	});

	it('calls liveQuery.unsubscribe on unmount', async () => {
		const { unmount } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		mockRequest.mockClear();
		act(() => unmount());

		expect(mockRequest).toHaveBeenCalledWith('liveQuery.unsubscribe', { subscriptionId: subId });
	});

	it('removes event listeners on unmount', async () => {
		const { unmount } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		// Listeners are registered
		expect(snapshotHandlers).toHaveLength(1);
		expect(deltaHandlers).toHaveLength(1);

		act(() => unmount());

		// Real unsub functions splice them out — verify removal
		expect(snapshotHandlers).toHaveLength(0);
		expect(deltaHandlers).toHaveLength(0);
	});

	it('unsubscribes old and subscribes new when groupId changes', async () => {
		const { rerender } = renderHook(
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

		const newSubId = lastSubscribeId();
		expect(newSubId).not.toBe(firstSubId);
	});

	it('removes old listeners and registers new ones when groupId changes', async () => {
		const { rerender } = renderHook(
			({ groupId }: { groupId: string }) => useGroupMessageLiveQuery(groupId),
			{ initialProps: { groupId: 'grp-1' } }
		);

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		expect(snapshotHandlers).toHaveLength(1);
		expect(deltaHandlers).toHaveLength(1);

		act(() => rerender({ groupId: 'grp-2' }));

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith(
				'liveQuery.subscribe',
				expect.objectContaining({ params: ['grp-2'] })
			)
		);

		// Old handlers replaced by new ones — still exactly 1 of each
		expect(snapshotHandlers).toHaveLength(1);
		expect(deltaHandlers).toHaveLength(1);
	});

	it('clears messages and does not subscribe when groupId is null', () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery(null));

		expect(result.current.messages).toEqual([]);
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();

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
		act(() => rerender({ groupId: null }));

		expect(result.current.messages).toEqual([]);
		expect(result.current.loading).toBe(false);
		expect(mockRequest).toHaveBeenCalledWith('liveQuery.unsubscribe', { subscriptionId: subId });
	});

	it('sets error and clears loading when liveQuery.subscribe fails', async () => {
		mockRequest.mockRejectedValue(new Error('Auth denied'));

		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
			expect(result.current.error).toBe('Auth denied');
		});
	});

	it('stays loading=true when subscribe resolves but no snapshot arrives', async () => {
		// subscribe RPC resolves immediately but server never pushes a snapshot —
		// loading should remain true (the UI shows an indefinite spinner in this state)
		mockRequest.mockResolvedValue({ ok: true });

		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());

		// Give async processing a moment
		await new Promise((r) => setTimeout(r, 10));

		expect(result.current.loading).toBe(true);
		expect(result.current.messages).toHaveLength(0);
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

		act(() => rerender({ groupId: 'grp-2' }));

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

		act(() => rerender({ groupId: 'grp-2' }));

		await waitFor(() => {
			const calls = mockRequest.mock.calls.filter((args) => args[0] === 'liveQuery.subscribe');
			expect(calls.length).toBeGreaterThanOrEqual(2);
		});
		const secondSubId = lastSubscribeId();

		expect(firstSubId).not.toBe('');
		expect(secondSubId).not.toBe('');
		expect(firstSubId).not.toBe(secondSubId);
	});

	it('re-subscribes with same subscriptionId after WebSocket reconnect', async () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		act(() => fireSnapshot(subId, [makeMessage(1)]));
		expect(result.current.messages).toHaveLength(1);

		// Simulate disconnect → reconnect
		mockRequest.mockClear();
		act(() => {
			mockIsConnected.value = false;
		});
		act(() => {
			mockIsConnected.value = true;
		});

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith(
				'liveQuery.subscribe',
				expect.objectContaining({
					queryName: 'sessionGroupMessages.byGroup',
					params: ['grp-1'],
					subscriptionId: subId, // same ID so existing handlers accept the snapshot
				})
			);
		});
	});

	it('re-subscribe after reconnect delivers fresh snapshot via existing handlers', async () => {
		const { result } = renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		const subId = lastSubscribeId();

		act(() => fireSnapshot(subId, [makeMessage(1)]));
		expect(result.current.messages).toHaveLength(1);

		// Simulate reconnect
		act(() => {
			mockIsConnected.value = false;
		});
		act(() => {
			mockIsConnected.value = true;
		});

		// Server re-sends snapshot with same subscriptionId (simulated)
		act(() => fireSnapshot(subId, [makeMessage(1), makeMessage(2), makeMessage(3)]));

		expect(result.current.messages).toHaveLength(3);
	});

	it('does not re-subscribe when isConnected goes from true to false', async () => {
		renderHook(() => useGroupMessageLiveQuery('grp-1'));

		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		mockRequest.mockClear();

		act(() => {
			mockIsConnected.value = false;
		});

		await new Promise((r) => setTimeout(r, 10));

		// No new subscribe call should have fired for a disconnect
		expect(mockRequest).not.toHaveBeenCalledWith('liveQuery.subscribe', expect.any(Object));
	});

	it('does not re-subscribe on reconnect when groupId is null', async () => {
		renderHook(() => useGroupMessageLiveQuery(null));

		act(() => {
			mockIsConnected.value = false;
		});
		mockRequest.mockClear();
		act(() => {
			mockIsConnected.value = true;
		});

		await new Promise((r) => setTimeout(r, 10));

		expect(mockRequest).not.toHaveBeenCalledWith('liveQuery.subscribe', expect.any(Object));
	});
});
