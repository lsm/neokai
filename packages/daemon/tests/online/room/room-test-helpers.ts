/**
 * Shared polling helpers for room online tests.
 */

import type { DaemonServerContext } from '../../helpers/daemon-server';
import type { NeoTask, RoomGoal } from '@neokai/shared';

export async function waitForTask(
	daemon: DaemonServerContext,
	roomId: string,
	filter: { taskType?: string; status?: string | string[] },
	timeout = 120_000
): Promise<NeoTask> {
	const start = Date.now();
	const statusArray = filter.status
		? Array.isArray(filter.status)
			? filter.status
			: [filter.status]
		: undefined;

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.list', { roomId })) as {
			tasks: NeoTask[];
		};
		const match = result.tasks.find(
			(t) =>
				(!filter.taskType || t.taskType === filter.taskType) &&
				(!statusArray || statusArray.includes(t.status))
		);
		if (match) return match;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for task matching ${JSON.stringify(filter)} in room ${roomId}`
	);
}

/**
 * Wait for a task matching the filter that is NOT in the excludeIds set.
 * Used to find newly created tasks after external failure.
 */
export async function waitForNewTask(
	daemon: DaemonServerContext,
	roomId: string,
	filter: { taskType?: string; status?: string | string[] },
	excludeIds: Set<string>,
	timeout = 120_000
): Promise<NeoTask> {
	const start = Date.now();
	const statusArray = filter.status
		? Array.isArray(filter.status)
			? filter.status
			: [filter.status]
		: undefined;

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.list', { roomId })) as {
			tasks: NeoTask[];
		};
		const match = result.tasks.find(
			(t) =>
				!excludeIds.has(t.id) &&
				(!filter.taskType || t.taskType === filter.taskType) &&
				(!statusArray || statusArray.includes(t.status))
		);
		if (match) return match;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for new task matching ${JSON.stringify(filter)} (excluding ${excludeIds.size} IDs)`
	);
}

export async function waitForTaskCount(
	daemon: DaemonServerContext,
	roomId: string,
	filter: { taskType?: string; status?: string | string[] },
	minCount: number,
	timeout = 120_000
): Promise<NeoTask[]> {
	const start = Date.now();
	const statusArray = filter.status
		? Array.isArray(filter.status)
			? filter.status
			: [filter.status]
		: undefined;

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.list', { roomId })) as {
			tasks: NeoTask[];
		};
		const matches = result.tasks.filter(
			(t) =>
				(!filter.taskType || t.taskType === filter.taskType) &&
				(!statusArray || statusArray.includes(t.status))
		);
		if (matches.length >= minCount) return matches;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for ${minCount}+ tasks matching ${JSON.stringify(filter)}`
	);
}

export async function waitForGroupState(
	daemon: DaemonServerContext,
	roomId: string,
	taskId: string,
	targetStates: string[],
	timeout = 120_000
): Promise<{ id: string; state: string; feedbackIteration: number }> {
	const start = Date.now();

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.getGroup', { roomId, taskId })) as {
			group: { id: string; state: string; feedbackIteration: number } | null;
		};
		if (result.group && targetStates.includes(result.group.state)) {
			return result.group;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for group state ${targetStates.join('|')} on task ${taskId}`
	);
}

export async function createRoom(daemon: DaemonServerContext, name: string): Promise<string> {
	const result = (await daemon.messageHub.request('room.create', {
		name: `${name} ${Date.now()}`,
	})) as { room: { id: string } };
	return result.room.id;
}

export async function createGoal(
	daemon: DaemonServerContext,
	roomId: string,
	title: string,
	description: string
): Promise<RoomGoal> {
	const result = (await daemon.messageHub.request('goal.create', {
		roomId,
		title,
		description,
	})) as { goal: RoomGoal };
	return result.goal;
}

export async function getGoal(
	daemon: DaemonServerContext,
	roomId: string,
	goalId: string
): Promise<RoomGoal> {
	return ((await daemon.messageHub.request('goal.get', { roomId, goalId })) as { goal: RoomGoal })
		.goal;
}

export async function listTasks(daemon: DaemonServerContext, roomId: string): Promise<NeoTask[]> {
	return ((await daemon.messageHub.request('task.list', { roomId })) as { tasks: NeoTask[] }).tasks;
}
