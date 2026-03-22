// @ts-nocheck
/**
 * Tests for useRoomLiveQuery Hook
 *
 * Verifies that the hook correctly manages the LiveQuery subscription
 * lifecycle by delegating to roomStore.subscribeRoom / unsubscribeRoom:
 *
 * - Calls subscribeRoom(roomId) on mount
 * - Calls unsubscribeRoom(oldRoomId) then subscribeRoom(newRoomId) on roomId change
 * - Calls unsubscribeRoom(roomId) on unmount
 * - Does NOT double-subscribe if called with the same roomId
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Hoisted mocks (must not import anything)
// ---------------------------------------------------------------------------

const { mockSubscribeRoom, mockUnsubscribeRoom } = vi.hoisted(() => ({
	mockSubscribeRoom: vi.fn().mockResolvedValue(undefined),
	mockUnsubscribeRoom: vi.fn(),
}));

// Mock roomStore so we control subscribeRoom and unsubscribeRoom directly.
vi.mock('../../lib/room-store', () => ({
	roomStore: {
		subscribeRoom: mockSubscribeRoom,
		unsubscribeRoom: mockUnsubscribeRoom,
	},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useRoomLiveQuery } from '../useRoomLiveQuery';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRoomLiveQuery', () => {
	beforeEach(() => {
		mockSubscribeRoom.mockClear();
		mockUnsubscribeRoom.mockClear();
	});

	it('calls subscribeRoom(roomId) on mount', () => {
		renderHook(() => useRoomLiveQuery('room-1'));

		expect(mockSubscribeRoom).toHaveBeenCalledTimes(1);
		expect(mockSubscribeRoom).toHaveBeenCalledWith('room-1');
	});

	it('calls unsubscribeRoom(roomId) on unmount', () => {
		const { unmount } = renderHook(() => useRoomLiveQuery('room-1'));

		expect(mockUnsubscribeRoom).not.toHaveBeenCalled();

		unmount();

		expect(mockUnsubscribeRoom).toHaveBeenCalledTimes(1);
		expect(mockUnsubscribeRoom).toHaveBeenCalledWith('room-1');
	});

	it('calls unsubscribeRoom(oldRoomId) then subscribeRoom(newRoomId) on roomId change', () => {
		const { rerender } = renderHook(({ roomId }) => useRoomLiveQuery(roomId), {
			initialProps: { roomId: 'room-1' },
		});

		expect(mockSubscribeRoom).toHaveBeenCalledTimes(1);
		expect(mockSubscribeRoom).toHaveBeenCalledWith('room-1');
		expect(mockUnsubscribeRoom).not.toHaveBeenCalled();

		mockSubscribeRoom.mockClear();
		mockUnsubscribeRoom.mockClear();

		rerender({ roomId: 'room-2' });

		// unsubscribeRoom for old room before subscribeRoom for new room
		expect(mockUnsubscribeRoom).toHaveBeenCalledTimes(1);
		expect(mockUnsubscribeRoom).toHaveBeenCalledWith('room-1');
		expect(mockSubscribeRoom).toHaveBeenCalledTimes(1);
		expect(mockSubscribeRoom).toHaveBeenCalledWith('room-2');

		// Verify unsubscribe was called before subscribe by checking call order
		const unsubCallOrder = mockUnsubscribeRoom.mock.invocationCallOrder[0];
		const subCallOrder = mockSubscribeRoom.mock.invocationCallOrder[0];
		expect(unsubCallOrder).toBeLessThan(subCallOrder);
	});

	it('does not re-subscribe when roomId is unchanged', () => {
		const { rerender } = renderHook(({ roomId }) => useRoomLiveQuery(roomId), {
			initialProps: { roomId: 'room-1' },
		});

		expect(mockSubscribeRoom).toHaveBeenCalledTimes(1);
		mockSubscribeRoom.mockClear();
		mockUnsubscribeRoom.mockClear();

		// Rerender with the same roomId
		rerender({ roomId: 'room-1' });

		expect(mockSubscribeRoom).not.toHaveBeenCalled();
		expect(mockUnsubscribeRoom).not.toHaveBeenCalled();
	});

	it('calls unsubscribeRoom with the last active roomId on unmount after room change', () => {
		const { rerender, unmount } = renderHook(({ roomId }) => useRoomLiveQuery(roomId), {
			initialProps: { roomId: 'room-1' },
		});

		rerender({ roomId: 'room-2' });

		mockUnsubscribeRoom.mockClear();

		unmount();

		expect(mockUnsubscribeRoom).toHaveBeenCalledTimes(1);
		expect(mockUnsubscribeRoom).toHaveBeenCalledWith('room-2');
	});
});
