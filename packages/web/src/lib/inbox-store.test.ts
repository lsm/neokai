/**
 * Tests for InboxStore
 *
 * Tests task aggregation across rooms, filtering to review status,
 * sorting, and computed reviewCount.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal } from '@preact/signals';
import type { Room, RoomOverview, TaskSummary } from '@neokai/shared';

// Hoisted mocks
const { mockGetHub } = vi.hoisted(() => ({
	mockGetHub: vi.fn(),
}));

vi.mock('./connection-manager', () => ({
	connectionManager: {
		getHub: mockGetHub,
	},
}));

// Lobby store mock rooms signal
const mockRoomsSignal = signal<Room[]>([]);
vi.mock('./lobby-store', () => ({
	lobbyStore: {
		get rooms() {
			return mockRoomsSignal;
		},
	},
}));

// Import after mocks are set up
const { inboxStore } = await import('./inbox-store.ts');

function makeRoom(id: string, name: string): Room {
	return {
		id,
		name,
		allowedPaths: [],
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeTask(id: string, status: TaskSummary['status'], updatedAt = Date.now()): TaskSummary {
	return {
		id,
		title: `Task ${id}`,
		status,
		priority: 'normal',
		progress: null,
		dependsOn: [],
		updatedAt,
	};
}

function makeOverview(room: Room, tasks: TaskSummary[]): RoomOverview {
	return {
		room,
		sessions: [],
		activeTasks: tasks.filter((t) => !['completed', 'cancelled'].includes(t.status)),
		allTasks: tasks,
	};
}

describe('InboxStore', () => {
	beforeEach(() => {
		mockRoomsSignal.value = [];
		inboxStore.items.value = [];
		inboxStore.isLoading.value = false;
		vi.clearAllMocks();
	});

	describe('refresh()', () => {
		it('should set items to empty array when no rooms', async () => {
			mockRoomsSignal.value = [];

			await inboxStore.refresh();

			expect(inboxStore.items.value).toEqual([]);
			expect(mockGetHub).not.toHaveBeenCalled();
		});

		it('should aggregate review-status tasks across rooms', async () => {
			const roomA = makeRoom('room-a', 'Room A');
			const roomB = makeRoom('room-b', 'Room B');
			mockRoomsSignal.value = [roomA, roomB];

			const tasksA = [makeTask('t1', 'review', 1000), makeTask('t2', 'in_progress', 2000)];
			const tasksB = [makeTask('t3', 'review', 3000), makeTask('t4', 'completed', 4000)];

			const mockHub = {
				request: vi
					.fn()
					.mockImplementationOnce(() => Promise.resolve(makeOverview(roomA, tasksA)))
					.mockImplementationOnce(() => Promise.resolve(makeOverview(roomB, tasksB))),
			};
			mockGetHub.mockResolvedValue(mockHub);

			await inboxStore.refresh();

			const items = inboxStore.items.value;
			expect(items).toHaveLength(2);

			// Both should be review tasks
			expect(items.every((item) => item.task.status === 'review')).toBe(true);

			// Should include correct room metadata
			const ids = items.map((i) => i.task.id);
			expect(ids).toContain('t1');
			expect(ids).toContain('t3');

			const itemA = items.find((i) => i.task.id === 't1');
			expect(itemA?.roomId).toBe('room-a');
			expect(itemA?.roomTitle).toBe('Room A');
		});

		it('should sort items by updatedAt descending', async () => {
			const room = makeRoom('room-1', 'Room 1');
			mockRoomsSignal.value = [room];

			const tasks = [
				makeTask('early', 'review', 1000),
				makeTask('latest', 'review', 3000),
				makeTask('middle', 'review', 2000),
			];

			const mockHub = {
				request: vi.fn().mockResolvedValue(makeOverview(room, tasks)),
			};
			mockGetHub.mockResolvedValue(mockHub);

			await inboxStore.refresh();

			const ids = inboxStore.items.value.map((i) => i.task.id);
			expect(ids).toEqual(['latest', 'middle', 'early']);
		});

		it('should skip failed room requests gracefully', async () => {
			const roomA = makeRoom('room-a', 'Room A');
			const roomB = makeRoom('room-b', 'Room B');
			mockRoomsSignal.value = [roomA, roomB];

			const tasksB = [makeTask('t1', 'review')];
			const mockHub = {
				request: vi
					.fn()
					.mockImplementationOnce(() => Promise.reject(new Error('Network error')))
					.mockImplementationOnce(() => Promise.resolve(makeOverview(roomB, tasksB))),
			};
			mockGetHub.mockResolvedValue(mockHub);

			await inboxStore.refresh();

			// Should still have tasks from the successful room
			expect(inboxStore.items.value).toHaveLength(1);
			expect(inboxStore.items.value[0].task.id).toBe('t1');
		});

		it('should set isLoading to false after completion', async () => {
			mockRoomsSignal.value = [makeRoom('r', 'R')];
			const mockHub = {
				request: vi.fn().mockResolvedValue(makeOverview(makeRoom('r', 'R'), [])),
			};
			mockGetHub.mockResolvedValue(mockHub);

			const refreshPromise = inboxStore.refresh();
			// Loading should be true while in flight
			expect(inboxStore.isLoading.value).toBe(true);

			await refreshPromise;
			expect(inboxStore.isLoading.value).toBe(false);
		});

		it('should ignore archived rooms', async () => {
			const activeRoom = makeRoom('active', 'Active Room');
			const archivedRoom = { ...makeRoom('archived', 'Archived Room'), status: 'archived' as const };
			mockRoomsSignal.value = [activeRoom, archivedRoom];

			const mockHub = {
				request: vi.fn().mockResolvedValue(makeOverview(activeRoom, [])),
			};
			mockGetHub.mockResolvedValue(mockHub);

			await inboxStore.refresh();

			// Only one request — for the active room
			expect(mockHub.request).toHaveBeenCalledTimes(1);
		});
	});

	describe('reviewCount', () => {
		it('should return 0 when items is empty', () => {
			inboxStore.items.value = [];
			expect(inboxStore.reviewCount.value).toBe(0);
		});

		it('should return the number of items', () => {
			const room = makeRoom('r', 'R');
			inboxStore.items.value = [
				{ task: makeTask('t1', 'review'), roomId: 'r', roomTitle: 'R' },
				{ task: makeTask('t2', 'review'), roomId: 'r', roomTitle: 'R' },
			];
			expect(inboxStore.reviewCount.value).toBe(2);
		});

		it('should update reactively when items change', () => {
			inboxStore.items.value = [];
			expect(inboxStore.reviewCount.value).toBe(0);

			inboxStore.items.value = [{ task: makeTask('t1', 'review'), roomId: 'r', roomTitle: 'R' }];
			expect(inboxStore.reviewCount.value).toBe(1);
		});
	});
});
