// @ts-nocheck
/**
 * Tests for useGroupMessages Hook
 *
 * Verifies LiveQuery subscription lifecycle for session group messages:
 * - Snapshot delivery (initial message load)
 * - Delta append (new messages via real-time push)
 * - Stale-event guard (rapid task switching)
 * - Append-only invariant (ignore updated/removed)
 * - Cleanup on unmount / groupId change
 * - Reconnect: re-subscribes after WebSocket disconnect/reconnect
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Hoisted mocks (must not import anything)
// ---------------------------------------------------------------------------

const { mockRequest, mockOnEvent, mockIsConnected } = vi.hoisted(() => ({
	mockRequest: vi.fn(),
	mockOnEvent: vi.fn(),
	mockIsConnected: { value: true },
}));

// Mock useMessageHub so we control request, onEvent, and isConnected directly.
vi.mock('../useMessageHub', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		get isConnected() {
			return mockIsConnected.value;
		},
	}),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
	useGroupMessages,
	generateGroupMessagesSubId,
	resetSubscriptionCounterForTesting,
	type SessionGroupMessage,
} from '../useGroupMessages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal SessionGroupMessage for use in tests. */
function makeMessage(id: number, content = `msg-${id}`): SessionGroupMessage {
	return {
		id,
		groupId: 'group-1',
		sessionId: null,
		role: 'assistant',
		messageType: 'text',
		content,
		createdAt: 1_000_000 + id,
	};
}

/** Handler registry keyed by event name for simulating server pushes. */
type EventHandler = (event: unknown) => void;
let eventHandlers: Record<string, EventHandler[]> = {};

function fireEvent(method: string, payload: unknown): void {
	(eventHandlers[method] ?? []).forEach((h) => h(payload));
}

/** Returns the subscriptionId from the most recent liveQuery.subscribe call. */
function lastSubscribeSubId(): string {
	const subscribeCalls = mockRequest.mock.calls.filter((call) => call[0] === 'liveQuery.subscribe');
	return subscribeCalls[subscribeCalls.length - 1][1].subscriptionId;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.resetAllMocks();
	resetSubscriptionCounterForTesting();
	mockIsConnected.value = true;
	eventHandlers = {};

	// Default: subscribe/unsubscribe resolve immediately.
	mockRequest.mockResolvedValue({ ok: true });

	// onEvent registers handlers and returns an unsubscribe stub.
	mockOnEvent.mockImplementation((method: string, handler: EventHandler) => {
		if (!eventHandlers[method]) eventHandlers[method] = [];
		eventHandlers[method].push(handler);
		return () => {
			eventHandlers[method] = (eventHandlers[method] ?? []).filter((h) => h !== handler);
		};
	});
});

// Note: no afterEach reset here. `beforeEach` resets mocks before each test.
// Adding vi.resetAllMocks() in afterEach would reset mocks before
// @testing-library/preact's cleanup fires, causing useEffect cleanup to fail
// when it calls request() (which would return undefined after reset).

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useGroupMessages', () => {
	describe('initial state', () => {
		it('returns empty messages and isLoading=false when groupId is null', () => {
			const { result } = renderHook(() => useGroupMessages(null));

			expect(result.current.messages).toEqual([]);
			expect(result.current.isLoading).toBe(false);
		});

		it('sets isLoading=true immediately when groupId is provided', () => {
			const { result } = renderHook(() => useGroupMessages('group-1'));

			expect(result.current.isLoading).toBe(true);
			expect(result.current.messages).toEqual([]);
		});

		it('calls liveQuery.subscribe with correct params on mount', () => {
			renderHook(() => useGroupMessages('group-abc'));

			expect(mockRequest).toHaveBeenCalledWith('liveQuery.subscribe', {
				queryName: 'sessionGroupMessages.byGroup',
				params: ['group-abc'],
				subscriptionId: expect.stringContaining('group-abc'),
			});
		});

		it('does not subscribe when not connected', () => {
			mockIsConnected.value = false;

			renderHook(() => useGroupMessages('group-1'));

			const subscribeCalls = mockRequest.mock.calls.filter(
				(call) => call[0] === 'liveQuery.subscribe'
			);
			expect(subscribeCalls).toHaveLength(0);
		});
	});

	describe('snapshot handling', () => {
		it('replaces messages and clears isLoading on snapshot', () => {
			const { result } = renderHook(() => useGroupMessages('group-1'));

			const subId = lastSubscribeSubId();
			const rows = [makeMessage(1), makeMessage(2)];

			act(() => {
				fireEvent('liveQuery.snapshot', { subscriptionId: subId, rows, version: 1 });
			});

			expect(result.current.messages).toEqual(rows);
			expect(result.current.isLoading).toBe(false);
		});

		it('discards snapshot with a stale subscriptionId', () => {
			const { result } = renderHook(() => useGroupMessages('group-1'));

			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: 'stale-sub-id-9999',
					rows: [makeMessage(99)],
					version: 1,
				});
			});

			expect(result.current.messages).toEqual([]);
		});
	});

	describe('delta handling', () => {
		it('appends added messages from delta', () => {
			const { result } = renderHook(() => useGroupMessages('group-1'));

			const subId = lastSubscribeSubId();

			// Deliver snapshot first.
			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: subId,
					rows: [makeMessage(1)],
					version: 1,
				});
			});

			// Deliver delta with one new message.
			act(() => {
				fireEvent('liveQuery.delta', {
					subscriptionId: subId,
					added: [makeMessage(2)],
					version: 2,
				});
			});

			expect(result.current.messages).toHaveLength(2);
			expect(result.current.messages[1].id).toBe(2);
		});

		it('appends multiple added messages from a single delta', () => {
			const { result } = renderHook(() => useGroupMessages('group-1'));

			const subId = lastSubscribeSubId();

			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: subId,
					rows: [],
					version: 1,
				});
			});

			act(() => {
				fireEvent('liveQuery.delta', {
					subscriptionId: subId,
					added: [makeMessage(1), makeMessage(2), makeMessage(3)],
					version: 2,
				});
			});

			expect(result.current.messages).toHaveLength(3);
		});

		it('ignores delta with no added field (append-only invariant)', () => {
			const { result } = renderHook(() => useGroupMessages('group-1'));

			const subId = lastSubscribeSubId();

			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: subId,
					rows: [makeMessage(1)],
					version: 1,
				});
			});

			// Delta with only updated/removed — should be ignored.
			act(() => {
				fireEvent('liveQuery.delta', {
					subscriptionId: subId,
					removed: [makeMessage(1)],
					updated: [makeMessage(1)],
					version: 2,
				});
			});

			expect(result.current.messages).toHaveLength(1);
		});

		it('ignores delta with empty added array', () => {
			const { result } = renderHook(() => useGroupMessages('group-1'));

			const subId = lastSubscribeSubId();

			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: subId,
					rows: [makeMessage(1)],
					version: 1,
				});
			});

			act(() => {
				fireEvent('liveQuery.delta', {
					subscriptionId: subId,
					added: [],
					version: 2,
				});
			});

			expect(result.current.messages).toHaveLength(1);
		});

		it('discards delta with stale subscriptionId', () => {
			const { result } = renderHook(() => useGroupMessages('group-1'));

			const subId = lastSubscribeSubId();

			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: subId,
					rows: [makeMessage(1)],
					version: 1,
				});
			});

			// Delta from old subscription.
			act(() => {
				fireEvent('liveQuery.delta', {
					subscriptionId: 'stale-delta-sub-9999',
					added: [makeMessage(99)],
					version: 2,
				});
			});

			expect(result.current.messages).toHaveLength(1);
			expect(result.current.messages[0].id).toBe(1);
		});
	});

	describe('stale-event guard (rapid task switching)', () => {
		it('discards snapshot from previous groupId after switching', () => {
			const { result, rerender } = renderHook(
				({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
				{ initialProps: { groupId: 'group-1' } }
			);

			const firstSubId = lastSubscribeSubId();

			// Switch to group-2 before first snapshot arrives.
			rerender({ groupId: 'group-2' });

			// Now the stale snapshot from group-1 arrives — should be discarded.
			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: firstSubId,
					rows: [makeMessage(99)],
					version: 1,
				});
			});

			expect(result.current.messages).toEqual([]);
		});

		it('accepts snapshot from current groupId after switching', () => {
			const { result, rerender } = renderHook(
				({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
				{ initialProps: { groupId: 'group-1' } }
			);

			rerender({ groupId: 'group-2' });

			// Find the subscribe call for group-2.
			const group2Call = mockRequest.mock.calls.find(
				(call) => call[0] === 'liveQuery.subscribe' && call[1]?.params?.[0] === 'group-2'
			);
			expect(group2Call).toBeDefined();
			const secondSubId = group2Call[1].subscriptionId;

			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: secondSubId,
					rows: [makeMessage(5)],
					version: 1,
				});
			});

			expect(result.current.messages).toHaveLength(1);
			expect(result.current.messages[0].id).toBe(5);
		});
	});

	describe('reconnect handling', () => {
		it('re-subscribes and refreshes messages after WebSocket reconnect', () => {
			const { result, rerender } = renderHook(
				({ isConn }: { isConn: boolean }) => {
					mockIsConnected.value = isConn;
					return useGroupMessages('group-1');
				},
				{ initialProps: { isConn: true } }
			);

			// Initial subscription — deliver snapshot with one message.
			const firstSubId = lastSubscribeSubId();
			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: firstSubId,
					rows: [makeMessage(1)],
					version: 1,
				});
			});
			expect(result.current.messages).toHaveLength(1);

			// Simulate disconnect: isConnected becomes false.
			act(() => {
				rerender({ isConn: false });
			});

			// Simulate reconnect: isConnected becomes true again.
			act(() => {
				rerender({ isConn: true });
			});

			// A new subscription should have been issued.
			const reconnectSubId = lastSubscribeSubId();
			expect(reconnectSubId).not.toBe(firstSubId);

			// Deliver the fresh snapshot from the new subscription.
			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: reconnectSubId,
					rows: [makeMessage(1), makeMessage(2)],
					version: 1,
				});
			});

			expect(result.current.messages).toHaveLength(2);
		});

		it('discards events from the pre-reconnect subscription after reconnect', () => {
			const { result, rerender } = renderHook(
				({ isConn }: { isConn: boolean }) => {
					mockIsConnected.value = isConn;
					return useGroupMessages('group-1');
				},
				{ initialProps: { isConn: true } }
			);

			const firstSubId = lastSubscribeSubId();
			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: firstSubId,
					rows: [makeMessage(1)],
					version: 1,
				});
			});

			// Reconnect cycle.
			act(() => {
				rerender({ isConn: false });
			});
			act(() => {
				rerender({ isConn: true });
			});

			// Stale delta from old subscription must be discarded.
			act(() => {
				fireEvent('liveQuery.delta', {
					subscriptionId: firstSubId,
					added: [makeMessage(99)],
					version: 2,
				});
			});

			// No messages until the new subscription delivers its snapshot.
			expect(result.current.messages).toEqual([]);
		});
	});

	describe('cleanup', () => {
		it('calls liveQuery.unsubscribe on unmount', () => {
			const { unmount } = renderHook(() => useGroupMessages('group-1'));

			const subId = lastSubscribeSubId();

			unmount();

			expect(mockRequest).toHaveBeenCalledWith('liveQuery.unsubscribe', {
				subscriptionId: subId,
			});
		});

		it('unsubscribes from previous group when groupId changes', () => {
			const { rerender } = renderHook(
				({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
				{ initialProps: { groupId: 'group-1' } }
			);

			const firstSubId = mockRequest.mock.calls[0][1].subscriptionId;

			rerender({ groupId: 'group-2' });

			expect(mockRequest).toHaveBeenCalledWith('liveQuery.unsubscribe', {
				subscriptionId: firstSubId,
			});
		});

		it('removes event listeners on unmount', () => {
			const { unmount } = renderHook(() => useGroupMessages('group-1'));

			unmount();

			// No handlers should remain registered.
			expect(eventHandlers['liveQuery.snapshot'] ?? []).toHaveLength(0);
			expect(eventHandlers['liveQuery.delta'] ?? []).toHaveLength(0);
		});

		it('clears messages and stops loading when groupId becomes null', () => {
			const { result, rerender } = renderHook(
				({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
				{ initialProps: { groupId: 'group-1' } }
			);

			const subId = lastSubscribeSubId();

			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: subId,
					rows: [makeMessage(1)],
					version: 1,
				});
			});

			expect(result.current.messages).toHaveLength(1);

			rerender({ groupId: null });

			expect(result.current.messages).toEqual([]);
			expect(result.current.isLoading).toBe(false);
		});
	});

	describe('subscribe error handling', () => {
		it('clears isLoading when subscribe request fails', async () => {
			mockRequest.mockRejectedValueOnce(new Error('subscribe failed'));

			const { result } = renderHook(() => useGroupMessages('group-1'));

			expect(result.current.isLoading).toBe(true);

			// Let microtasks drain so the .catch() handler runs.
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			expect(result.current.isLoading).toBe(false);
		});

		it('does not clear isLoading after error if groupId already changed', async () => {
			let rejectSubscribe: (err: Error) => void;
			// First call (group-1 subscribe) hangs.
			mockRequest.mockReturnValueOnce(
				new Promise<never>((_, reject) => {
					rejectSubscribe = reject;
				})
			);
			// Subsequent calls (unsubscribe + group-2 subscribe) resolve.
			mockRequest.mockResolvedValue({ ok: true });

			const { result, rerender } = renderHook(
				({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
				{ initialProps: { groupId: 'group-1' } }
			);

			// Switch to group-2 before group-1 subscribe settles.
			rerender({ groupId: 'group-2' });

			// Reject group-1's subscribe after the switch.
			await act(async () => {
				rejectSubscribe(new Error('late failure'));
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			// group-2 is still loading (snapshot hasn't arrived) — stale error must
			// not clear the loading flag.
			expect(result.current.isLoading).toBe(true);
		});
	});

	describe('generateGroupMessagesSubId', () => {
		it('includes the groupId in the subscription ID', () => {
			const id = generateGroupMessagesSubId('my-group');
			expect(id).toContain('my-group');
		});

		it('generates unique IDs for successive calls', () => {
			const id1 = generateGroupMessagesSubId('g');
			const id2 = generateGroupMessagesSubId('g');
			expect(id1).not.toBe(id2);
		});

		it('counter resets between tests via resetSubscriptionCounterForTesting', () => {
			// Counter was reset in beforeEach; first call should produce counter=1.
			const id = generateGroupMessagesSubId('g');
			expect(id).toBe('group-messages-g-1');
		});
	});
});
