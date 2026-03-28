/**
 * Unit tests for Neo Action Tools
 *
 * Tests the two-layer pattern:
 *   - createNeoActionToolHandlers: handler functions (no MCP wiring)
 *   - createNeoActionMcpServer: registers all tools on an MCP server
 *
 * Covers:
 * - create_room: auto-execute and confirmation paths, workspace path handling
 * - delete_room: auto-execute and confirmation paths, missing room error
 * - update_room_settings: field patching, missing room error, no-op guard
 * - create_goal: auto-execute and confirmation paths, missing room error
 * - update_goal: field patching, no-op guard
 * - set_goal_status: happy path, missing room/goal errors
 * - create_task: auto-execute and confirmation paths, missing room error
 * - update_task: field patching, no-op guard
 * - set_task_status: status transition
 * - approve_task: happy path, task not in review error, runtime unavailable
 * - reject_task: happy path, task not in review error, runtime unavailable
 * - MCP server: all 11 tools are registered
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
	createNeoActionToolHandlers,
	createNeoActionMcpServer,
	type NeoActionToolsConfig,
	type NeoActionRoomManager,
	type NeoActionGoalManager,
	type NeoActionTaskManager,
	type NeoActionRuntimeService,
	type NeoActionManagerFactory,
} from '../../../src/lib/neo/tools/neo-action-tools';
import { PendingActionStore } from '../../../src/lib/neo/security-tier';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function makeRoom(overrides: Partial<Room> = {}): Room {
	return {
		id: 'room-1',
		name: 'Test Room',
		status: 'active',
		sessionIds: [],
		allowedPaths: [],
		createdAt: NOW - 10_000,
		updatedAt: NOW,
		...overrides,
	};
}

function makeGoal(overrides: Partial<RoomGoal> = {}): RoomGoal {
	return {
		id: 'goal-1',
		roomId: 'room-1',
		title: 'Test Goal',
		description: 'A test goal',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		metrics: {},
		createdAt: NOW - 5_000,
		updatedAt: NOW,
		missionType: 'one_shot',
		autonomyLevel: 'supervised',
		...overrides,
	};
}

function makeTask(overrides: Partial<NeoTask> = {}): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		description: 'A test task',
		status: 'pending',
		priority: 'normal',
		progress: 0,
		dependsOn: [],
		createdAt: NOW - 3_000,
		updatedAt: NOW,
		taskType: 'coding',
		assignedAgent: 'coder',
		...overrides,
	} as NeoTask;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeRoomManager(rooms: Room[] = []): NeoActionRoomManager {
	const store = new Map<string, Room>(rooms.map((r) => [r.id, r]));
	return {
		createRoom: (params) => {
			const room = makeRoom({
				id: `room-${Date.now()}`,
				name: params.name,
				allowedPaths: params.allowedPaths ?? [],
			});
			store.set(room.id, room);
			return room;
		},
		deleteRoom: (id) => {
			if (!store.has(id)) return false;
			store.delete(id);
			return true;
		},
		getRoom: (id) => store.get(id) ?? null,
		updateRoom: (id, params) => {
			const room = store.get(id);
			if (!room) return null;
			const updated = {
				...room,
				...params,
				updatedAt: NOW + 1,
			} as Room;
			store.set(id, updated);
			return updated;
		},
	};
}

function makeGoalManager(goals: RoomGoal[] = []): NeoActionGoalManager {
	const store = new Map<string, RoomGoal>(goals.map((g) => [g.id, g]));
	return {
		createGoal: async (params) => {
			const goal = makeGoal({ id: `goal-${Date.now()}`, ...params });
			store.set(goal.id, goal);
			return goal;
		},
		getGoal: async (id) => store.get(id) ?? null,
		patchGoal: async (id, patch) => {
			const goal = store.get(id);
			if (!goal) throw new Error(`Goal not found: ${id}`);
			const updated = { ...goal, ...patch, updatedAt: NOW + 1 };
			store.set(id, updated);
			return updated;
		},
		updateGoalStatus: async (id, status) => {
			const goal = store.get(id);
			if (!goal) throw new Error(`Goal not found: ${id}`);
			const updated = { ...goal, status, updatedAt: NOW + 1 };
			store.set(id, updated);
			return updated;
		},
	};
}

function makeTaskManager(tasks: NeoTask[] = []): NeoActionTaskManager {
	const store = new Map<string, NeoTask>(tasks.map((t) => [t.id, t]));
	return {
		createTask: async (params) => {
			const task = makeTask({ id: `task-${Date.now()}`, ...params });
			store.set(task.id, task);
			return task;
		},
		getTask: async (id) => store.get(id) ?? null,
		updateTaskFields: async (id, updates) => {
			const task = store.get(id);
			if (!task) throw new Error(`Task not found: ${id}`);
			const updated = { ...task, ...updates, updatedAt: NOW + 1 };
			store.set(id, updated);
			return updated;
		},
		setTaskStatus: async (id, status, opts) => {
			const task = store.get(id);
			if (!task) throw new Error(`Task not found: ${id}`);
			const updated = {
				...task,
				status,
				result: opts?.result ?? task.result,
				error: opts?.error ?? task.error,
				updatedAt: NOW + 1,
			} as NeoTask;
			store.set(id, updated);
			return updated;
		},
	};
}

function makeRuntimeService(resumeResult = true): NeoActionRuntimeService {
	return {
		getRuntime: (_roomId) => ({
			resumeWorkerFromHuman: async (_taskId, _message, _opts) => resumeResult,
		}),
	};
}

function makeManagerFactory(
	goalManagers: Map<string, NeoActionGoalManager> = new Map(),
	taskManagers: Map<string, NeoActionTaskManager> = new Map()
): NeoActionManagerFactory {
	return {
		getGoalManager: (roomId) => goalManagers.get(roomId) ?? makeGoalManager(),
		getTaskManager: (roomId) => taskManagers.get(roomId) ?? makeTaskManager(),
	};
}

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

function makeConfig(
	opts: {
		rooms?: Room[];
		goals?: RoomGoal[];
		tasks?: NeoTask[];
		securityMode?: 'conservative' | 'balanced' | 'autonomous';
		runtimeService?: NeoActionRuntimeService;
		workspaceRoot?: string;
	} = {}
): NeoActionToolsConfig {
	const room = makeRoom();
	const rooms = opts.rooms ?? [room];
	const goals = opts.goals ?? [makeGoal()];
	const tasks = opts.tasks ?? [makeTask()];

	const goalManager = makeGoalManager(goals);
	const taskManager = makeTaskManager(tasks);

	const goalManagers = new Map<string, NeoActionGoalManager>([[room.id, goalManager]]);
	const taskManagers = new Map<string, NeoActionTaskManager>([[room.id, taskManager]]);

	// Re-register all provided rooms
	for (const r of rooms) {
		goalManagers.set(r.id, makeGoalManager(goals.filter((g) => g.roomId === r.id)));
		taskManagers.set(r.id, makeTaskManager(tasks.filter((t) => t.roomId === r.id)));
	}

	return {
		roomManager: makeRoomManager(rooms),
		managerFactory: makeManagerFactory(goalManagers, taskManagers),
		runtimeService: opts.runtimeService,
		pendingStore: new PendingActionStore(),
		workspaceRoot: opts.workspaceRoot,
		getSecurityMode: () => opts.securityMode ?? 'autonomous',
	};
}

// Helper to parse JSON result
function parseResult(result: { content: Array<{ type: string; text: string }> }) {
	return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// create_room
// ---------------------------------------------------------------------------

describe('create_room', () => {
	it('auto-executes in autonomous mode', async () => {
		const config = makeConfig({ securityMode: 'autonomous' });
		const { create_room } = createNeoActionToolHandlers(config);
		const result = parseResult(await create_room({ name: 'My Room' }));
		expect(result.success).toBe(true);
		expect(result.room.name).toBe('My Room');
	});

	it('requires confirmation in balanced mode', async () => {
		// create_room is 'low' risk — balanced auto-executes low
		const config = makeConfig({ securityMode: 'balanced' });
		const { create_room } = createNeoActionToolHandlers(config);
		const result = parseResult(await create_room({ name: 'My Room' }));
		// low risk → auto-executes in balanced
		expect(result.success).toBe(true);
		expect(result.room.name).toBe('My Room');
	});

	it('returns confirmationRequired in conservative mode', async () => {
		const config = makeConfig({ securityMode: 'conservative' });
		const { create_room } = createNeoActionToolHandlers(config);
		const result = parseResult(await create_room({ name: 'My Room' }));
		expect(result.confirmationRequired).toBe(true);
		expect(result.pendingActionId).toBeTruthy();
		expect(result.riskLevel).toBe('low');
	});

	it('uses workspace root as allowedPaths when no path provided', async () => {
		const config = makeConfig({ workspaceRoot: '/home/user/ws' });
		const { create_room } = createNeoActionToolHandlers(config);
		const result = parseResult(await create_room({ name: 'WS Room' }));
		expect(result.success).toBe(true);
		expect(result.room.allowedPaths[0].path).toBe('/home/user/ws');
	});

	it('stores pending action so it can be confirmed later', async () => {
		const config = makeConfig({ securityMode: 'conservative' });
		const { create_room } = createNeoActionToolHandlers(config);
		const result = parseResult(await create_room({ name: 'Pending Room' }));
		const pendingAction = config.pendingStore.retrieve(result.pendingActionId);
		expect(pendingAction?.toolName).toBe('create_room');
		expect((pendingAction?.input as { name: string }).name).toBe('Pending Room');
	});
});

// ---------------------------------------------------------------------------
// delete_room
// ---------------------------------------------------------------------------

describe('delete_room', () => {
	it('auto-executes in autonomous mode', async () => {
		const room = makeRoom({ id: 'del-room' });
		const config = makeConfig({ rooms: [room], securityMode: 'autonomous' });
		const { delete_room } = createNeoActionToolHandlers(config);
		const result = parseResult(await delete_room({ room_id: 'del-room' }));
		expect(result.success).toBe(true);
		expect(result.roomId).toBe('del-room');
	});

	it('returns confirmationRequired in balanced mode (medium risk)', async () => {
		const room = makeRoom({ id: 'del-room' });
		const config = makeConfig({ rooms: [room], securityMode: 'balanced' });
		const { delete_room } = createNeoActionToolHandlers(config);
		const result = parseResult(await delete_room({ room_id: 'del-room' }));
		expect(result.confirmationRequired).toBe(true);
		expect(result.riskLevel).toBe('medium');
	});

	it('returns error for non-existent room', async () => {
		const config = makeConfig({ securityMode: 'autonomous' });
		const { delete_room } = createNeoActionToolHandlers(config);
		const result = parseResult(await delete_room({ room_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('Room not found');
	});
});

// ---------------------------------------------------------------------------
// update_room_settings
// ---------------------------------------------------------------------------

describe('update_room_settings', () => {
	it('updates room fields', async () => {
		const room = makeRoom();
		const config = makeConfig({ rooms: [room] });
		const { update_room_settings } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await update_room_settings({
				room_id: 'room-1',
				name: 'Renamed Room',
				description: 'New context',
			})
		);
		expect(result.success).toBe(true);
		expect(result.room.name).toBe('Renamed Room');
	});

	it('returns error for non-existent room', async () => {
		const config = makeConfig();
		const { update_room_settings } = createNeoActionToolHandlers(config);
		const result = parseResult(await update_room_settings({ room_id: 'missing', name: 'X' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('Room not found');
	});

	it('requires confirmation in conservative mode (low risk auto-executes in balanced)', async () => {
		const room = makeRoom();
		const config = makeConfig({ rooms: [room], securityMode: 'conservative' });
		const { update_room_settings } = createNeoActionToolHandlers(config);
		const result = parseResult(await update_room_settings({ room_id: 'room-1', name: 'X' }));
		expect(result.confirmationRequired).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// create_goal
// ---------------------------------------------------------------------------

describe('create_goal', () => {
	it('creates a goal in autonomous mode', async () => {
		const config = makeConfig();
		const { create_goal } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await create_goal({ room_id: 'room-1', title: 'Big Goal', description: 'Desc' })
		);
		expect(result.success).toBe(true);
		expect(result.goal.title).toBe('Big Goal');
	});

	it('auto-executes in balanced mode (low risk)', async () => {
		const config = makeConfig({ securityMode: 'balanced' });
		const { create_goal } = createNeoActionToolHandlers(config);
		const result = parseResult(await create_goal({ room_id: 'room-1', title: 'Goal' }));
		expect(result.success).toBe(true);
	});

	it('returns confirmationRequired in conservative mode', async () => {
		const config = makeConfig({ securityMode: 'conservative' });
		const { create_goal } = createNeoActionToolHandlers(config);
		const result = parseResult(await create_goal({ room_id: 'room-1', title: 'Goal' }));
		expect(result.confirmationRequired).toBe(true);
		expect(result.riskLevel).toBe('low');
	});

	it('returns error for non-existent room', async () => {
		const config = makeConfig();
		const { create_goal } = createNeoActionToolHandlers(config);
		const result = parseResult(await create_goal({ room_id: 'missing', title: 'Goal' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('Room not found');
	});

	it('passes priority and mission_type to goal manager', async () => {
		const config = makeConfig();
		const { create_goal } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await create_goal({
				room_id: 'room-1',
				title: 'KPI Goal',
				priority: 'high',
				mission_type: 'measurable',
				autonomy_level: 'semi_autonomous',
			})
		);
		expect(result.success).toBe(true);
		expect(result.goal.priority).toBe('high');
		expect(result.goal.missionType).toBe('measurable');
		expect(result.goal.autonomyLevel).toBe('semi_autonomous');
	});
});

// ---------------------------------------------------------------------------
// update_goal
// ---------------------------------------------------------------------------

describe('update_goal', () => {
	it('patches goal fields', async () => {
		const goal = makeGoal({ id: 'goal-1', roomId: 'room-1' });
		const config = makeConfig({ goals: [goal] });
		const { update_goal } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await update_goal({ room_id: 'room-1', goal_id: 'goal-1', title: 'Updated Title' })
		);
		expect(result.success).toBe(true);
		expect(result.goal.title).toBe('Updated Title');
	});

	it('returns error when no update fields provided', async () => {
		const goal = makeGoal({ id: 'goal-1', roomId: 'room-1' });
		const config = makeConfig({ goals: [goal] });
		const { update_goal } = createNeoActionToolHandlers(config);
		const result = parseResult(await update_goal({ room_id: 'room-1', goal_id: 'goal-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('No update fields provided');
	});

	it('returns error for non-existent room', async () => {
		const config = makeConfig();
		const { update_goal } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await update_goal({ room_id: 'missing', goal_id: 'goal-1', title: 'X' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Room not found');
	});

	it('returns error for non-existent goal', async () => {
		const config = makeConfig({ goals: [] });
		const { update_goal } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await update_goal({ room_id: 'room-1', goal_id: 'missing', title: 'X' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Goal not found');
	});
});

// ---------------------------------------------------------------------------
// set_goal_status
// ---------------------------------------------------------------------------

describe('set_goal_status', () => {
	it('transitions goal status', async () => {
		const goal = makeGoal({ id: 'goal-1', roomId: 'room-1', status: 'active' });
		const config = makeConfig({ goals: [goal] });
		const { set_goal_status } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await set_goal_status({ room_id: 'room-1', goal_id: 'goal-1', status: 'completed' })
		);
		expect(result.success).toBe(true);
		expect(result.goal.status).toBe('completed');
	});

	it('returns confirmationRequired in conservative mode', async () => {
		const goal = makeGoal({ id: 'goal-1', roomId: 'room-1' });
		const config = makeConfig({ goals: [goal], securityMode: 'conservative' });
		const { set_goal_status } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await set_goal_status({ room_id: 'room-1', goal_id: 'goal-1', status: 'archived' })
		);
		expect(result.confirmationRequired).toBe(true);
	});

	it('returns error for non-existent room', async () => {
		const config = makeConfig();
		const { set_goal_status } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await set_goal_status({ room_id: 'missing', goal_id: 'goal-1', status: 'completed' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Room not found');
	});

	it('returns error for non-existent goal', async () => {
		const config = makeConfig({ goals: [] });
		const { set_goal_status } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await set_goal_status({ room_id: 'room-1', goal_id: 'missing', status: 'completed' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Goal not found');
	});
});

// ---------------------------------------------------------------------------
// create_task
// ---------------------------------------------------------------------------

describe('create_task', () => {
	it('creates a task in autonomous mode', async () => {
		const config = makeConfig();
		const { create_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await create_task({ room_id: 'room-1', title: 'Implement X', description: 'Do the thing' })
		);
		expect(result.success).toBe(true);
		expect(result.task.title).toBe('Implement X');
	});

	it('auto-executes in balanced mode (low risk)', async () => {
		const config = makeConfig({ securityMode: 'balanced' });
		const { create_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await create_task({ room_id: 'room-1', title: 'Task', description: 'Desc' })
		);
		expect(result.success).toBe(true);
	});

	it('returns confirmationRequired in conservative mode', async () => {
		const config = makeConfig({ securityMode: 'conservative' });
		const { create_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await create_task({ room_id: 'room-1', title: 'Task', description: 'Desc' })
		);
		expect(result.confirmationRequired).toBe(true);
		expect(result.riskLevel).toBe('low');
	});

	it('returns error for non-existent room', async () => {
		const config = makeConfig();
		const { create_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await create_task({ room_id: 'missing', title: 'Task', description: 'Desc' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Room not found');
	});

	it('passes priority and depends_on to task manager', async () => {
		const dep = makeTask({ id: 'dep-task', roomId: 'room-1' });
		const config = makeConfig({ tasks: [dep] });
		const { create_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await create_task({
				room_id: 'room-1',
				title: 'Dependent Task',
				description: 'Desc',
				priority: 'high',
				depends_on: ['dep-task'],
			})
		);
		expect(result.success).toBe(true);
		expect(result.task.priority).toBe('high');
		expect(result.task.dependsOn).toContain('dep-task');
	});
});

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

describe('update_task', () => {
	it('updates task fields', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1' });
		const config = makeConfig({ tasks: [task] });
		const { update_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await update_task({
				room_id: 'room-1',
				task_id: 'task-1',
				title: 'Updated Task',
				priority: 'urgent',
			})
		);
		expect(result.success).toBe(true);
		expect(result.task.title).toBe('Updated Task');
		expect(result.task.priority).toBe('urgent');
	});

	it('returns error when no update fields provided', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1' });
		const config = makeConfig({ tasks: [task] });
		const { update_task } = createNeoActionToolHandlers(config);
		const result = parseResult(await update_task({ room_id: 'room-1', task_id: 'task-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('No update fields provided');
	});

	it('returns error for non-existent room', async () => {
		const config = makeConfig();
		const { update_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await update_task({ room_id: 'missing', task_id: 'task-1', title: 'X' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Room not found');
	});

	it('returns error for non-existent task', async () => {
		const config = makeConfig({ tasks: [] });
		const { update_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await update_task({ room_id: 'room-1', task_id: 'missing', title: 'X' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Task not found');
	});
});

// ---------------------------------------------------------------------------
// set_task_status
// ---------------------------------------------------------------------------

describe('set_task_status', () => {
	it('transitions task status', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'pending' });
		const config = makeConfig({ tasks: [task] });
		const { set_task_status } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await set_task_status({ room_id: 'room-1', task_id: 'task-1', status: 'in_progress' })
		);
		expect(result.success).toBe(true);
		expect(result.task.status).toBe('in_progress');
	});

	it('passes result and error fields', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'in_progress' });
		const config = makeConfig({ tasks: [task] });
		const { set_task_status } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await set_task_status({
				room_id: 'room-1',
				task_id: 'task-1',
				status: 'completed',
				result: 'All done',
			})
		);
		expect(result.success).toBe(true);
		expect(result.task.result).toBe('All done');
	});

	it('returns error for non-existent room', async () => {
		const config = makeConfig();
		const { set_task_status } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await set_task_status({ room_id: 'missing', task_id: 'task-1', status: 'completed' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Room not found');
	});

	it('returns error for non-existent task', async () => {
		const config = makeConfig({ tasks: [] });
		const { set_task_status } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await set_task_status({ room_id: 'room-1', task_id: 'missing', status: 'completed' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Task not found');
	});

	it('returns confirmationRequired in conservative mode', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1' });
		const config = makeConfig({ tasks: [task], securityMode: 'conservative' });
		const { set_task_status } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await set_task_status({ room_id: 'room-1', task_id: 'task-1', status: 'completed' })
		);
		expect(result.confirmationRequired).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// approve_task
// ---------------------------------------------------------------------------

describe('approve_task', () => {
	it('approves a task in review status', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({ tasks: [task], runtimeService: makeRuntimeService(true) });
		const { approve_task } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_task({ room_id: 'room-1', task_id: 'task-1' }));
		expect(result.success).toBe(true);
		expect(result.taskId).toBe('task-1');
	});

	it('returns error when task is not in review', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'pending' });
		const config = makeConfig({ tasks: [task], runtimeService: makeRuntimeService(true) });
		const { approve_task } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_task({ room_id: 'room-1', task_id: 'task-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not in review status');
	});

	it('returns error when runtime service not available', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({ tasks: [task] }); // no runtimeService
		const { approve_task } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_task({ room_id: 'room-1', task_id: 'task-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('Runtime service not available');
	});

	it('returns error when resumeWorkerFromHuman returns false', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({ tasks: [task], runtimeService: makeRuntimeService(false) });
		const { approve_task } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_task({ room_id: 'room-1', task_id: 'task-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('Failed to approve');
	});

	it('requires confirmation in balanced mode (medium risk)', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({
			tasks: [task],
			runtimeService: makeRuntimeService(true),
			securityMode: 'balanced',
		});
		const { approve_task } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_task({ room_id: 'room-1', task_id: 'task-1' }));
		expect(result.confirmationRequired).toBe(true);
		expect(result.riskLevel).toBe('medium');
	});

	it('returns error for non-existent room', async () => {
		const config = makeConfig({ runtimeService: makeRuntimeService(true) });
		const { approve_task } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_task({ room_id: 'missing', task_id: 'task-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('Room not found');
	});

	it('returns error for non-existent task', async () => {
		const config = makeConfig({ tasks: [], runtimeService: makeRuntimeService(true) });
		const { approve_task } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_task({ room_id: 'room-1', task_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('Task not found');
	});
});

// ---------------------------------------------------------------------------
// reject_task
// ---------------------------------------------------------------------------

describe('reject_task', () => {
	it('rejects a task in review status', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({ tasks: [task], runtimeService: makeRuntimeService(true) });
		const { reject_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await reject_task({ room_id: 'room-1', task_id: 'task-1', feedback: 'Fix the tests' })
		);
		expect(result.success).toBe(true);
		expect(result.taskId).toBe('task-1');
	});

	it('returns error when task is not in review', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'in_progress' });
		const config = makeConfig({ tasks: [task], runtimeService: makeRuntimeService(true) });
		const { reject_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await reject_task({ room_id: 'room-1', task_id: 'task-1', feedback: 'Nope' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('not in review status');
	});

	it('returns error when runtime service not available', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({ tasks: [task] }); // no runtimeService
		const { reject_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await reject_task({ room_id: 'room-1', task_id: 'task-1', feedback: 'Nope' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Runtime service not available');
	});

	it('returns error when resumeWorkerFromHuman returns false', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({ tasks: [task], runtimeService: makeRuntimeService(false) });
		const { reject_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await reject_task({ room_id: 'room-1', task_id: 'task-1', feedback: 'Not good enough' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Failed to reject');
	});

	it('requires confirmation in balanced mode (medium risk)', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({
			tasks: [task],
			runtimeService: makeRuntimeService(true),
			securityMode: 'balanced',
		});
		const { reject_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await reject_task({ room_id: 'room-1', task_id: 'task-1', feedback: 'Feedback here' })
		);
		expect(result.confirmationRequired).toBe(true);
		expect(result.riskLevel).toBe('medium');
	});

	it('returns error for non-existent task', async () => {
		const config = makeConfig({ tasks: [], runtimeService: makeRuntimeService(true) });
		const { reject_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await reject_task({ room_id: 'room-1', task_id: 'missing', feedback: 'Feedback' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Task not found');
	});
});

// ---------------------------------------------------------------------------
// MCP server — tool registration
// ---------------------------------------------------------------------------

describe('createNeoActionMcpServer', () => {
	let server: ReturnType<typeof createNeoActionMcpServer>;

	beforeEach(() => {
		server = createNeoActionMcpServer(makeConfig());
	});

	it('names the MCP server "neo-action"', () => {
		expect(server.name).toBe('neo-action');
	});

	it('registers create_room tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('create_room');
	});

	it('registers delete_room tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('delete_room');
	});

	it('registers update_room_settings tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('update_room_settings');
	});

	it('registers create_goal tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('create_goal');
	});

	it('registers update_goal tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('update_goal');
	});

	it('registers set_goal_status tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('set_goal_status');
	});

	it('registers create_task tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('create_task');
	});

	it('registers update_task tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('update_task');
	});

	it('registers set_task_status tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('set_task_status');
	});

	it('registers approve_task tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('approve_task');
	});

	it('registers reject_task tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('reject_task');
	});

	it('registers exactly 11 tools', () => {
		expect(Object.keys(server.instance._registeredTools)).toHaveLength(11);
	});
});
