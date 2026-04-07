/**
 * Tests for useRoomLiveQuery Hook
 *
 * Verifies that the hook correctly manages the LiveQuery subscription
 * lifecycle by delegating to per-query subscribe/unsubscribe methods:
 *
 * - Tasks LiveQuery: always subscribed (regardless of activeTab)
 * - Goals LiveQuery: always subscribed (consumed by sidebar, task badges, etc.)
 * - Skills LiveQuery: subscribed only when activeTab is 'agents' or 'settings'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Hoisted mocks (must not import anything)
// ---------------------------------------------------------------------------

const {
	mockSubscribeRoomTasks,
	mockUnsubscribeRoomTasks,
	mockSubscribeRoomGoals,
	mockUnsubscribeRoomGoals,
	mockSubscribeRoomSkills,
	mockUnsubscribeRoomSkills,
} = vi.hoisted(() => ({
	mockSubscribeRoomTasks: vi.fn().mockResolvedValue(undefined),
	mockUnsubscribeRoomTasks: vi.fn(),
	mockSubscribeRoomGoals: vi.fn().mockResolvedValue(undefined),
	mockUnsubscribeRoomGoals: vi.fn(),
	mockSubscribeRoomSkills: vi.fn().mockResolvedValue(undefined),
	mockUnsubscribeRoomSkills: vi.fn(),
}));

// Mock roomStore so we control per-query subscribe/unsubscribe methods directly.
vi.mock('../../lib/room-store', () => ({
	roomStore: {
		subscribeRoomTasks: mockSubscribeRoomTasks,
		unsubscribeRoomTasks: mockUnsubscribeRoomTasks,
		subscribeRoomGoals: mockSubscribeRoomGoals,
		unsubscribeRoomGoals: mockUnsubscribeRoomGoals,
		subscribeRoomSkills: mockSubscribeRoomSkills,
		unsubscribeRoomSkills: mockUnsubscribeRoomSkills,
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
		mockSubscribeRoomTasks.mockClear();
		mockUnsubscribeRoomTasks.mockClear();
		mockSubscribeRoomGoals.mockClear();
		mockUnsubscribeRoomGoals.mockClear();
		mockSubscribeRoomSkills.mockClear();
		mockUnsubscribeRoomSkills.mockClear();
	});

	// ---- Tasks subscription (always on) ----

	describe('tasks subscription', () => {
		it('subscribes to tasks on mount', () => {
			renderHook(() => useRoomLiveQuery('room-1', 'overview'));

			expect(mockSubscribeRoomTasks).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomTasks).toHaveBeenCalledWith('room-1');
		});

		it('unsubscribes from tasks on unmount', () => {
			const { unmount } = renderHook(() => useRoomLiveQuery('room-1', 'overview'));

			expect(mockUnsubscribeRoomTasks).not.toHaveBeenCalled();

			unmount();

			expect(mockUnsubscribeRoomTasks).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeRoomTasks).toHaveBeenCalledWith('room-1');
		});

		it('persists across tab changes', () => {
			const { rerender } = renderHook(({ activeTab }) => useRoomLiveQuery('room-1', activeTab), {
				initialProps: { activeTab: 'overview' },
			});

			expect(mockSubscribeRoomTasks).toHaveBeenCalledTimes(1);
			mockSubscribeRoomTasks.mockClear();

			// Switch to goals tab — tasks should NOT re-subscribe
			rerender({ activeTab: 'goals' });
			expect(mockSubscribeRoomTasks).not.toHaveBeenCalled();

			// Switch to agents tab — tasks should NOT re-subscribe
			rerender({ activeTab: 'agents' });
			expect(mockSubscribeRoomTasks).not.toHaveBeenCalled();
		});

		it('resubscribes on roomId change', () => {
			const { rerender } = renderHook(({ roomId }) => useRoomLiveQuery(roomId, 'overview'), {
				initialProps: { roomId: 'room-1' },
			});

			mockUnsubscribeRoomTasks.mockClear();
			mockSubscribeRoomTasks.mockClear();

			rerender({ roomId: 'room-2' });

			expect(mockUnsubscribeRoomTasks).toHaveBeenCalledWith('room-1');
			expect(mockSubscribeRoomTasks).toHaveBeenCalledWith('room-2');
		});
	});

	// ---- Goals subscription (always on) ----

	describe('goals subscription', () => {
		it('subscribes to goals on mount', () => {
			renderHook(() => useRoomLiveQuery('room-1', 'overview'));

			expect(mockSubscribeRoomGoals).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomGoals).toHaveBeenCalledWith('room-1');
		});

		it('unsubscribes from goals on unmount', () => {
			const { unmount } = renderHook(() => useRoomLiveQuery('room-1', 'overview'));

			expect(mockUnsubscribeRoomGoals).not.toHaveBeenCalled();

			unmount();

			expect(mockUnsubscribeRoomGoals).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeRoomGoals).toHaveBeenCalledWith('room-1');
		});

		it('persists across tab changes', () => {
			const { rerender } = renderHook(({ activeTab }) => useRoomLiveQuery('room-1', activeTab), {
				initialProps: { activeTab: 'overview' },
			});

			expect(mockSubscribeRoomGoals).toHaveBeenCalledTimes(1);
			mockSubscribeRoomGoals.mockClear();

			// Switch through several tabs — goals should NOT re-subscribe
			rerender({ activeTab: 'tasks' });
			rerender({ activeTab: 'agents' });
			rerender({ activeTab: 'settings' });
			expect(mockSubscribeRoomGoals).not.toHaveBeenCalled();
		});

		it('resubscribes on roomId change', () => {
			const { rerender } = renderHook(({ roomId }) => useRoomLiveQuery(roomId, 'overview'), {
				initialProps: { roomId: 'room-1' },
			});

			mockUnsubscribeRoomGoals.mockClear();
			mockSubscribeRoomGoals.mockClear();

			rerender({ roomId: 'room-2' });

			expect(mockUnsubscribeRoomGoals).toHaveBeenCalledWith('room-1');
			expect(mockSubscribeRoomGoals).toHaveBeenCalledWith('room-2');
		});
	});

	// ---- Skills subscription (conditional) ----

	describe('skills subscription', () => {
		it('does not subscribe to skills on overview tab', () => {
			renderHook(() => useRoomLiveQuery('room-1', 'overview'));

			expect(mockSubscribeRoomSkills).not.toHaveBeenCalled();
		});

		it('does not subscribe to skills on tasks tab', () => {
			renderHook(() => useRoomLiveQuery('room-1', 'tasks'));

			expect(mockSubscribeRoomSkills).not.toHaveBeenCalled();
		});

		it('does not subscribe to skills on goals tab', () => {
			renderHook(() => useRoomLiveQuery('room-1', 'goals'));

			expect(mockSubscribeRoomSkills).not.toHaveBeenCalled();
		});

		it('does not subscribe to skills on chat tab', () => {
			renderHook(() => useRoomLiveQuery('room-1', 'chat'));

			expect(mockSubscribeRoomSkills).not.toHaveBeenCalled();
		});

		it('subscribes to skills when activeTab changes to agents', () => {
			const { rerender } = renderHook(({ activeTab }) => useRoomLiveQuery('room-1', activeTab), {
				initialProps: { activeTab: 'overview' },
			});

			expect(mockSubscribeRoomSkills).not.toHaveBeenCalled();

			rerender({ activeTab: 'agents' });

			expect(mockSubscribeRoomSkills).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomSkills).toHaveBeenCalledWith('room-1');
		});

		it('subscribes to skills when activeTab changes to settings', () => {
			const { rerender } = renderHook(({ activeTab }) => useRoomLiveQuery('room-1', activeTab), {
				initialProps: { activeTab: 'overview' },
			});

			expect(mockSubscribeRoomSkills).not.toHaveBeenCalled();

			rerender({ activeTab: 'settings' });

			expect(mockSubscribeRoomSkills).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomSkills).toHaveBeenCalledWith('room-1');
		});

		it('unsubscribes from skills when leaving agents tab', () => {
			const { rerender } = renderHook(({ activeTab }) => useRoomLiveQuery('room-1', activeTab), {
				initialProps: { activeTab: 'agents' },
			});

			expect(mockSubscribeRoomSkills).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeRoomSkills).not.toHaveBeenCalled();

			rerender({ activeTab: 'overview' });

			expect(mockUnsubscribeRoomSkills).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeRoomSkills).toHaveBeenCalledWith('room-1');
		});

		it('unsubscribes from skills when leaving settings tab', () => {
			const { rerender } = renderHook(({ activeTab }) => useRoomLiveQuery('room-1', activeTab), {
				initialProps: { activeTab: 'settings' },
			});

			expect(mockSubscribeRoomSkills).toHaveBeenCalledTimes(1);

			rerender({ activeTab: 'overview' });

			expect(mockUnsubscribeRoomSkills).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeRoomSkills).toHaveBeenCalledWith('room-1');
		});

		it('switches skills subscription between agents and settings without unsubscribing', () => {
			const { rerender } = renderHook(({ activeTab }) => useRoomLiveQuery('room-1', activeTab), {
				initialProps: { activeTab: 'agents' },
			});

			expect(mockSubscribeRoomSkills).toHaveBeenCalledTimes(1);
			mockSubscribeRoomSkills.mockClear();

			// Switch from agents to settings — should resubscribe (effect re-runs)
			rerender({ activeTab: 'settings' });
			expect(mockSubscribeRoomSkills).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomSkills).toHaveBeenCalledWith('room-1');
		});

		it('does not subscribe to skills when activeTab is null', () => {
			renderHook(() => useRoomLiveQuery('room-1', null));

			expect(mockSubscribeRoomSkills).not.toHaveBeenCalled();
		});

		it('direct navigation to agents tab subscribes immediately', () => {
			renderHook(() => useRoomLiveQuery('room-1', 'agents'));

			expect(mockSubscribeRoomSkills).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomSkills).toHaveBeenCalledWith('room-1');
		});

		it('direct navigation to settings tab subscribes immediately', () => {
			renderHook(() => useRoomLiveQuery('room-1', 'settings'));

			expect(mockSubscribeRoomSkills).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomSkills).toHaveBeenCalledWith('room-1');
		});

		it('unsubscribes from skills on unmount while on agents tab', () => {
			const { unmount } = renderHook(() => useRoomLiveQuery('room-1', 'agents'));

			expect(mockUnsubscribeRoomSkills).not.toHaveBeenCalled();

			unmount();

			expect(mockUnsubscribeRoomSkills).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeRoomSkills).toHaveBeenCalledWith('room-1');
		});

		it('does not unsubscribe skills on unmount when not on agents/settings tab', () => {
			const { unmount } = renderHook(() => useRoomLiveQuery('room-1', 'overview'));

			unmount();

			expect(mockUnsubscribeRoomSkills).not.toHaveBeenCalled();
		});
	});

	// ---- Combined behavior ----

	describe('combined subscriptions', () => {
		it('mounting with overview tab subscribes to tasks and goals but not skills', () => {
			renderHook(() => useRoomLiveQuery('room-1', 'overview'));

			expect(mockSubscribeRoomTasks).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomGoals).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomSkills).not.toHaveBeenCalled();
		});

		it('changing to agents tab adds skills subscription', () => {
			const { rerender } = renderHook(({ activeTab }) => useRoomLiveQuery('room-1', activeTab), {
				initialProps: { activeTab: 'overview' },
			});

			expect(mockSubscribeRoomTasks).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomGoals).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomSkills).not.toHaveBeenCalled();

			rerender({ activeTab: 'agents' });

			expect(mockSubscribeRoomSkills).toHaveBeenCalledTimes(1);
			// Tasks and goals should not re-subscribe
			expect(mockSubscribeRoomTasks).toHaveBeenCalledTimes(1);
			expect(mockSubscribeRoomGoals).toHaveBeenCalledTimes(1);
		});

		it('all subscriptions clean up on unmount', () => {
			const { unmount } = renderHook(() => useRoomLiveQuery('room-1', 'agents'));

			unmount();

			expect(mockUnsubscribeRoomTasks).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeRoomGoals).toHaveBeenCalledTimes(1);
			expect(mockUnsubscribeRoomSkills).toHaveBeenCalledTimes(1);
		});
	});
});
