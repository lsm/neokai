/**
 * InboxStore - Aggregates review-status tasks across all rooms
 *
 * Data layer for the Inbox feature. Fans out room.get requests in parallel
 * to collect all tasks with status === 'review', providing a unified inbox view.
 *
 * No dedicated inbox API exists on the backend; this store composes
 * existing room.get RPC calls (same pattern as RoomStore.fetchInitialState).
 */

import { signal, computed } from '@preact/signals';
import type { TaskSummary, RoomOverview } from '@neokai/shared';
import { connectionManager } from './connection-manager';
import { lobbyStore } from './lobby-store';
import { toast } from './toast';

/**
 * A review-status task enriched with room metadata for inbox display
 */
export interface InboxTask {
	task: TaskSummary;
	roomId: string;
	roomTitle: string;
}

const items = signal<InboxTask[]>([]);
const isLoading = signal<boolean>(false);

/**
 * Computed count of tasks awaiting review
 */
const reviewCount = computed(() => items.value.length);

/**
 * Fan out room.get requests to all rooms in parallel, collect review-status tasks,
 * and update the items signal sorted by updatedAt descending.
 */
async function refresh(): Promise<void> {
	const rooms = lobbyStore.rooms.value.filter((r) => r.status === 'active');
	if (rooms.length === 0) {
		items.value = [];
		return;
	}

	isLoading.value = true;
	try {
		const hub = await connectionManager.getHub();

		const results = await Promise.all(
			rooms.map((room) =>
				hub
					.request<RoomOverview>('room.get', { roomId: room.id })
					.then((overview) => ({ overview, room }))
					.catch(() => null)
			)
		);

		const inbox: InboxTask[] = [];
		for (const result of results) {
			if (!result?.overview) continue;
			const { overview, room } = result;
			const tasks = overview.allTasks ?? overview.activeTasks;
			for (const task of tasks) {
				if (task.status === 'review') {
					inbox.push({ task, roomId: room.id, roomTitle: room.name });
				}
			}
		}

		// Sort by updatedAt descending (most recently updated first)
		inbox.sort((a, b) => b.task.updatedAt - a.task.updatedAt);

		items.value = inbox;
	} finally {
		isLoading.value = false;
	}
}

async function approveTask(taskId: string, roomId: string): Promise<boolean> {
	try {
		const hub = await connectionManager.getHub();
		await hub.request('room.task.approve', { roomId, taskId });
		await refresh();
		return true;
	} catch (err) {
		toast.error(err instanceof Error ? err.message : 'Failed to approve task');
		return false;
	}
}

async function rejectTask(taskId: string, roomId: string, feedback: string): Promise<boolean> {
	try {
		const hub = await connectionManager.getHub();
		await hub.request('room.task.reject', { roomId, taskId, feedback });
		await refresh();
		return true;
	} catch (err) {
		toast.error(err instanceof Error ? err.message : 'Failed to reject task');
		return false;
	}
}

export const inboxStore = {
	items,
	isLoading,
	refresh,
	reviewCount,
	approveTask,
	rejectTask,
};
