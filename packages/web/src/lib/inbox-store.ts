/**
 * InboxStore - Aggregates review-status tasks across all rooms
 *
 * Data layer for the Inbox feature. Calls the dedicated inbox.reviewTasks RPC
 * endpoint to fetch all tasks with status === 'review' in a single request,
 * providing a unified inbox view without the overhead of per-room room.get calls.
 */

import { signal, computed } from '@preact/signals';
import type { TaskSummary } from '@neokai/shared/types/neo';
import { connectionManager } from './connection-manager';
import { toast } from './toast';

export interface InboxTask {
	task: TaskSummary;
	roomId: string;
	roomTitle: string;
}

const items = signal<InboxTask[]>([]);
const isLoading = signal<boolean>(false);
const reviewCount = computed(() => items.value.length);

async function refresh(): Promise<void> {
	isLoading.value = true;
	try {
		const hub = await connectionManager.getHub();
		const result = await hub.request<{ tasks: InboxTask[] }>('inbox.reviewTasks', {});
		items.value = result.tasks;
	} catch {
		items.value = [];
	} finally {
		isLoading.value = false;
	}
}

async function approveTask(taskId: string, roomId: string): Promise<boolean> {
	try {
		const hub = await connectionManager.getHub();
		await hub.request('task.approve', { roomId, taskId });
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
		await hub.request('task.reject', { roomId, taskId, feedback });
		await refresh();
		return true;
	} catch (err) {
		toast.error(err instanceof Error ? err.message : 'Failed to reject task');
		return false;
	}
}

export const inboxStore = { items, isLoading, refresh, reviewCount, approveTask, rejectTask };
