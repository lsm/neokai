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
 * - create_space: auto-execute and confirmation paths, unavailable guard
 * - update_space: auto-execute and no-op guard
 * - delete_space: auto-execute and confirmation paths
 * - start_workflow_run: auto-execute and confirmation paths
 * - cancel_workflow_run: happy path, already-cancelled, completed error, unavailable guard
 * - approve_gate: happy path, idempotent, rejection override, terminal-run error
 * - reject_gate: happy path, idempotent, reason propagation, terminal-run error
 * - MCP server: all 18 tools are registered
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
	type NeoActionSpaceHandlers,
	type NeoActionWorkflowRunRepository,
	type NeoActionSpaceTaskManagerFactory,
	type NeoActionGateDataRepository,
	type NeoWorkflowRun,
	type NeoSpaceTask,
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

function makeRoomManager(
	rooms: Room[] = [],
	activeSessionCounts: Map<string, number> = new Map()
): NeoActionRoomManager {
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
		getActiveSessionCount: (id) => activeSessionCounts.get(id) ?? 0,
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

// ---------------------------------------------------------------------------
// Space/Workflow mock factories
// ---------------------------------------------------------------------------

type SpaceToolResult = { content: Array<{ type: 'text'; text: string }> };

function makeSpaceHandlers(override: Partial<NeoActionSpaceHandlers> = {}): NeoActionSpaceHandlers {
	const defaultResult = (): Promise<SpaceToolResult> =>
		Promise.resolve({
			content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
		});
	return {
		create_space: override.create_space ?? ((_args) => defaultResult()),
		update_space: override.update_space ?? ((_args) => defaultResult()),
		delete_space: override.delete_space ?? ((_args) => defaultResult()),
		start_workflow_run: override.start_workflow_run ?? ((_args) => defaultResult()),
	};
}

function makeWorkflowRun(overrides: Partial<NeoWorkflowRun> = {}): NeoWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'space-1',
		status: 'in_progress',
		failureReason: null,
		...overrides,
	};
}

function makeWorkflowRunRepo(
	runs: NeoWorkflowRun[] = []
): NeoActionWorkflowRunRepository & { _runs: Map<string, NeoWorkflowRun> } {
	const store = new Map<string, NeoWorkflowRun>(runs.map((r) => [r.id, r]));
	return {
		_runs: store,
		getRun: (id) => store.get(id) ?? null,
		transitionStatus: (id, to) => {
			const run = store.get(id);
			if (!run) throw new Error(`Run not found: ${id}`);
			const updated = { ...run, status: to };
			store.set(id, updated);
			return updated;
		},
		updateRun: (id, params) => {
			const run = store.get(id);
			if (!run) return null;
			const updated = { ...run, ...params };
			store.set(id, updated);
			return updated;
		},
	};
}

function makeSpaceTask(overrides: Partial<NeoSpaceTask> = {}): NeoSpaceTask {
	return { id: 'stask-1', status: 'pending', ...overrides };
}

function makeSpaceTaskManagerFactory(
	tasks: NeoSpaceTask[] = []
): NeoActionSpaceTaskManagerFactory & { _cancelledIds: string[] } {
	const cancelledIds: string[] = [];
	return {
		_cancelledIds: cancelledIds,
		getTaskManager: (_spaceId) => ({
			listTasksByWorkflowRun: async (_runId) => tasks,
			cancelTask: async (taskId) => {
				cancelledIds.push(taskId);
			},
		}),
	};
}

function makeGateDataRepo(): NeoActionGateDataRepository & {
	_store: Map<string, Record<string, unknown>>;
} {
	const store = new Map<string, Record<string, unknown>>();
	return {
		_store: store,
		get: (runId, gateId) => {
			const key = `${runId}:${gateId}`;
			const data = store.get(key);
			return data ? { data } : null;
		},
		merge: (runId, gateId, partial) => {
			const key = `${runId}:${gateId}`;
			const existing = store.get(key) ?? {};
			const merged = { ...existing, ...partial };
			store.set(key, merged);
			return { data: merged };
		},
	};
}

function makeConfig(
	opts: {
		rooms?: Room[];
		goals?: RoomGoal[];
		tasks?: NeoTask[];
		securityMode?: 'conservative' | 'balanced' | 'autonomous';
		runtimeService?: NeoActionRuntimeService;
		workspaceRoot?: string;
		/** Simulate active session counts per room ID for delete_room escalation tests */
		activeSessionCounts?: Map<string, number>;
		spaceHandlers?: NeoActionSpaceHandlers;
		workflowRunRepo?: NeoActionWorkflowRunRepository;
		spaceTaskManagerFactory?: NeoActionSpaceTaskManagerFactory;
		gateDataRepo?: NeoActionGateDataRepository;
		onGateChanged?: (runId: string, gateId: string) => Promise<void> | void;
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
		roomManager: makeRoomManager(rooms, opts.activeSessionCounts),
		managerFactory: makeManagerFactory(goalManagers, taskManagers),
		runtimeService: opts.runtimeService,
		pendingStore: new PendingActionStore(),
		workspaceRoot: opts.workspaceRoot,
		getSecurityMode: () => opts.securityMode ?? 'autonomous',
		spaceHandlers: opts.spaceHandlers,
		workflowRunRepo: opts.workflowRunRepo,
		spaceTaskManagerFactory: opts.spaceTaskManagerFactory,
		gateDataRepo: opts.gateDataRepo,
		onGateChanged: opts.onGateChanged,
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

	it('workspace_path takes precedence over workspaceRoot', async () => {
		const config = makeConfig({ workspaceRoot: '/default/ws' });
		const { create_room } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await create_room({ name: 'Custom WS Room', workspace_path: '/custom/path' })
		);
		expect(result.success).toBe(true);
		expect(result.room.allowedPaths[0].path).toBe('/custom/path');
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

	it('escalates to high risk (delete_room_with_active_tasks) when room has active sessions', async () => {
		const room = makeRoom({ id: 'busy-room' });
		// balanced: delete_room (medium) would require confirmation, but active sessions
		// escalate to delete_room_with_active_tasks (high) which also requires confirmation in balanced
		const config = makeConfig({
			rooms: [room],
			securityMode: 'balanced',
			activeSessionCounts: new Map([['busy-room', 2]]),
		});
		const { delete_room } = createNeoActionToolHandlers(config);
		const result = parseResult(await delete_room({ room_id: 'busy-room' }));
		expect(result.confirmationRequired).toBe(true);
		expect(result.riskLevel).toBe('high');
	});

	it('does NOT escalate when room has no active sessions', async () => {
		// In autonomous mode, delete_room (medium) with 0 active sessions should still execute
		const room = makeRoom({ id: 'quiet-room' });
		const config = makeConfig({
			rooms: [room],
			securityMode: 'autonomous',
			activeSessionCounts: new Map([['quiet-room', 0]]),
		});
		const { delete_room } = createNeoActionToolHandlers(config);
		const result = parseResult(await delete_room({ room_id: 'quiet-room' }));
		expect(result.success).toBe(true);
		expect(result.roomId).toBe('quiet-room');
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

	it('returns error when no update fields provided (no-op guard)', async () => {
		const room = makeRoom();
		const config = makeConfig({ rooms: [room] });
		const { update_room_settings } = createNeoActionToolHandlers(config);
		// Only room_id provided, no update fields
		const result = parseResult(await update_room_settings({ room_id: 'room-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('No update fields provided');
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

	it('returns error for non-existent room', async () => {
		const config = makeConfig({ runtimeService: makeRuntimeService(true) });
		const { reject_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await reject_task({ room_id: 'missing', task_id: 'task-1', feedback: 'Feedback' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Room not found');
	});

	it('returns error for empty feedback', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({ tasks: [task], runtimeService: makeRuntimeService(true) });
		const { reject_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await reject_task({ room_id: 'room-1', task_id: 'task-1', feedback: '' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Feedback is required');
	});

	it('returns error for whitespace-only feedback', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({ tasks: [task], runtimeService: makeRuntimeService(true) });
		const { reject_task } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await reject_task({ room_id: 'room-1', task_id: 'task-1', feedback: '   ' })
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Feedback is required');
	});

	it('empty feedback error fires before security check (no pending action stored)', async () => {
		const task = makeTask({ id: 'task-1', roomId: 'room-1', status: 'review' });
		const config = makeConfig({
			tasks: [task],
			runtimeService: makeRuntimeService(true),
			securityMode: 'conservative',
		});
		const { reject_task } = createNeoActionToolHandlers(config);
		await reject_task({ room_id: 'room-1', task_id: 'task-1', feedback: '' });
		// Nothing should have been stored in the pending store
		expect(config.pendingStore.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// create_space
// ---------------------------------------------------------------------------

describe('create_space', () => {
	it('delegates to spaceHandlers in autonomous mode', async () => {
		let called = false;
		const handlers = makeSpaceHandlers({
			create_space: async (args) => {
				called = true;
				return {
					content: [{ type: 'text', text: JSON.stringify({ success: true, name: args.name }) }],
				};
			},
		});
		const config = makeConfig({ spaceHandlers: handlers, securityMode: 'autonomous' });
		const { create_space } = createNeoActionToolHandlers(config);
		const result = parseResult(await create_space({ name: 'My Space', workspace_path: '/ws' }));
		expect(called).toBe(true);
		expect(result.success).toBe(true);
		expect(result.name).toBe('My Space');
	});

	it('returns confirmation in balanced mode (low risk — auto-executes)', async () => {
		// create_space is low risk, so balanced mode auto-executes it too
		const handlers = makeSpaceHandlers();
		const config = makeConfig({ spaceHandlers: handlers, securityMode: 'balanced' });
		const { create_space } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await create_space({ name: 'Test Space', workspace_path: '/workspace' })
		);
		expect(result.success).toBe(true);
	});

	it('requires confirmation in conservative mode', async () => {
		const handlers = makeSpaceHandlers();
		const config = makeConfig({ spaceHandlers: handlers, securityMode: 'conservative' });
		const { create_space } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await create_space({ name: 'Test Space', workspace_path: '/workspace' })
		);
		expect(result.confirmationRequired).toBe(true);
		expect(result.pendingActionId).toBeTruthy();
	});

	it('returns error when spaceHandlers not configured', async () => {
		const config = makeConfig({ securityMode: 'autonomous' });
		const { create_space } = createNeoActionToolHandlers(config);
		const result = parseResult(await create_space({ name: 'Test', workspace_path: '/ws' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not available');
	});
});

// ---------------------------------------------------------------------------
// update_space
// ---------------------------------------------------------------------------

describe('update_space', () => {
	it('delegates to spaceHandlers in autonomous mode', async () => {
		let calledWith: unknown;
		const handlers = makeSpaceHandlers({
			update_space: async (args) => {
				calledWith = args;
				return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
			},
		});
		const config = makeConfig({ spaceHandlers: handlers, securityMode: 'autonomous' });
		const { update_space } = createNeoActionToolHandlers(config);
		await update_space({ space_id: 'space-1', name: 'New Name' });
		expect((calledWith as Record<string, unknown>).name).toBe('New Name');
	});

	it('returns error when no update fields provided', async () => {
		const config = makeConfig({ spaceHandlers: makeSpaceHandlers(), securityMode: 'autonomous' });
		const { update_space } = createNeoActionToolHandlers(config);
		const result = parseResult(await update_space({ space_id: 'space-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('No update fields');
	});

	it('returns error when spaceHandlers not configured', async () => {
		const config = makeConfig({ securityMode: 'autonomous' });
		const { update_space } = createNeoActionToolHandlers(config);
		const result = parseResult(await update_space({ space_id: 'space-1', name: 'x' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not available');
	});

	it('auto-executes in balanced mode (low risk)', async () => {
		const handlers = makeSpaceHandlers();
		const config = makeConfig({ spaceHandlers: handlers, securityMode: 'balanced' });
		const { update_space } = createNeoActionToolHandlers(config);
		const result = parseResult(await update_space({ space_id: 'space-1', name: 'New Name' }));
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// delete_space
// ---------------------------------------------------------------------------

describe('delete_space', () => {
	it('delegates to spaceHandlers in autonomous mode', async () => {
		let calledId = '';
		const handlers = makeSpaceHandlers({
			delete_space: async (args) => {
				calledId = args.space_id;
				return {
					content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: true }) }],
				};
			},
		});
		const config = makeConfig({ spaceHandlers: handlers, securityMode: 'autonomous' });
		const { delete_space } = createNeoActionToolHandlers(config);
		const result = parseResult(await delete_space({ space_id: 'space-42' }));
		expect(calledId).toBe('space-42');
		expect(result.success).toBe(true);
		expect(result.deleted).toBe(true);
	});

	it('requires confirmation in balanced mode (medium risk)', async () => {
		const handlers = makeSpaceHandlers();
		const config = makeConfig({ spaceHandlers: handlers, securityMode: 'balanced' });
		const { delete_space } = createNeoActionToolHandlers(config);
		const result = parseResult(await delete_space({ space_id: 'space-1' }));
		expect(result.confirmationRequired).toBe(true);
		expect(result.riskLevel).toBe('medium');
	});

	it('returns error when spaceHandlers not configured', async () => {
		const config = makeConfig({ securityMode: 'autonomous' });
		const { delete_space } = createNeoActionToolHandlers(config);
		const result = parseResult(await delete_space({ space_id: 'space-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not available');
	});
});

// ---------------------------------------------------------------------------
// start_workflow_run
// ---------------------------------------------------------------------------

describe('start_workflow_run', () => {
	it('delegates to spaceHandlers in autonomous mode', async () => {
		let calledArgs: unknown;
		const handlers = makeSpaceHandlers({
			start_workflow_run: async (args) => {
				calledArgs = args;
				return {
					content: [
						{ type: 'text', text: JSON.stringify({ success: true, run: { id: 'run-1' } }) },
					],
				};
			},
		});
		const config = makeConfig({ spaceHandlers: handlers, securityMode: 'autonomous' });
		const { start_workflow_run } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await start_workflow_run({ workflow_id: 'wf-1', title: 'Test Run', space_id: 'space-1' })
		);
		expect((calledArgs as Record<string, unknown>).workflow_id).toBe('wf-1');
		expect(result.run.id).toBe('run-1');
	});

	it('auto-executes in balanced mode (low risk)', async () => {
		const handlers = makeSpaceHandlers();
		const config = makeConfig({ spaceHandlers: handlers, securityMode: 'balanced' });
		const { start_workflow_run } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await start_workflow_run({ workflow_id: 'wf-1', title: 'Test Run' })
		);
		expect(result.success).toBe(true);
	});

	it('requires confirmation in conservative mode', async () => {
		const handlers = makeSpaceHandlers();
		const config = makeConfig({ spaceHandlers: handlers, securityMode: 'conservative' });
		const { start_workflow_run } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await start_workflow_run({ workflow_id: 'wf-1', title: 'Test Run' })
		);
		expect(result.confirmationRequired).toBe(true);
	});

	it('returns error when spaceHandlers not configured', async () => {
		const config = makeConfig({ securityMode: 'autonomous' });
		const { start_workflow_run } = createNeoActionToolHandlers(config);
		const result = parseResult(await start_workflow_run({ workflow_id: 'wf-1', title: 'x' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not available');
	});
});

// ---------------------------------------------------------------------------
// cancel_workflow_run
// ---------------------------------------------------------------------------

describe('cancel_workflow_run', () => {
	it('cancels active tasks and transitions run to cancelled', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'in_progress' });
		const runRepo = makeWorkflowRunRepo([run]);
		const tasks = [
			makeSpaceTask({ id: 'st-1', status: 'pending' }),
			makeSpaceTask({ id: 'st-2', status: 'in_progress' }),
			makeSpaceTask({ id: 'st-3', status: 'completed' }),
		];
		const taskFactory = makeSpaceTaskManagerFactory(tasks);
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: runRepo,
			spaceTaskManagerFactory: taskFactory,
		});
		const { cancel_workflow_run } = createNeoActionToolHandlers(config);
		const result = parseResult(await cancel_workflow_run({ run_id: 'run-1' }));
		expect(result.success).toBe(true);
		expect(result.runId).toBe('run-1');
		// pending and in_progress should be cancelled; completed is skipped
		expect(taskFactory._cancelledIds).toContain('st-1');
		expect(taskFactory._cancelledIds).toContain('st-2');
		expect(taskFactory._cancelledIds).not.toContain('st-3');
		expect(runRepo._runs.get('run-1')?.status).toBe('cancelled');
	});

	it('returns success with alreadyCancelled when run is already cancelled', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'cancelled' });
		const runRepo = makeWorkflowRunRepo([run]);
		const taskFactory = makeSpaceTaskManagerFactory();
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: runRepo,
			spaceTaskManagerFactory: taskFactory,
		});
		const { cancel_workflow_run } = createNeoActionToolHandlers(config);
		const result = parseResult(await cancel_workflow_run({ run_id: 'run-1' }));
		expect(result.success).toBe(true);
		expect(result.alreadyCancelled).toBe(true);
	});

	it('returns error when run is completed', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'completed' });
		const runRepo = makeWorkflowRunRepo([run]);
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: runRepo,
			spaceTaskManagerFactory: makeSpaceTaskManagerFactory(),
		});
		const { cancel_workflow_run } = createNeoActionToolHandlers(config);
		const result = parseResult(await cancel_workflow_run({ run_id: 'run-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('Cannot cancel a completed');
	});

	it('returns error when run not found', async () => {
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: makeWorkflowRunRepo(),
			spaceTaskManagerFactory: makeSpaceTaskManagerFactory(),
		});
		const { cancel_workflow_run } = createNeoActionToolHandlers(config);
		const result = parseResult(await cancel_workflow_run({ run_id: 'missing' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not found');
	});

	it('requires confirmation in balanced mode (medium risk)', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'in_progress' });
		const config = makeConfig({
			securityMode: 'balanced',
			workflowRunRepo: makeWorkflowRunRepo([run]),
			spaceTaskManagerFactory: makeSpaceTaskManagerFactory(),
		});
		const { cancel_workflow_run } = createNeoActionToolHandlers(config);
		const result = parseResult(await cancel_workflow_run({ run_id: 'run-1' }));
		expect(result.confirmationRequired).toBe(true);
		expect(result.riskLevel).toBe('medium');
	});

	it('returns error when workflowRunRepo not configured', async () => {
		const config = makeConfig({ securityMode: 'autonomous' });
		const { cancel_workflow_run } = createNeoActionToolHandlers(config);
		const result = parseResult(await cancel_workflow_run({ run_id: 'run-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not available');
	});
});

// ---------------------------------------------------------------------------
// approve_gate
// ---------------------------------------------------------------------------

describe('approve_gate', () => {
	it('writes approved gate data', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'in_progress' });
		const runRepo = makeWorkflowRunRepo([run]);
		const gateRepo = makeGateDataRepo();
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: runRepo,
			gateDataRepo: gateRepo,
		});
		const { approve_gate } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_gate({ run_id: 'run-1', gate_id: 'gate-1' }));
		expect(result.success).toBe(true);
		expect(result.gateData.approved).toBe(true);
		expect(result.gateData.approvedAt).toBeDefined();
	});

	it('calls onGateChanged after approval', async () => {
		let notifiedRun = '';
		let notifiedGate = '';
		const run = makeWorkflowRun({ id: 'run-1', status: 'in_progress' });
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: makeWorkflowRunRepo([run]),
			gateDataRepo: makeGateDataRepo(),
			onGateChanged: (runId, gateId) => {
				notifiedRun = runId;
				notifiedGate = gateId;
			},
		});
		const { approve_gate } = createNeoActionToolHandlers(config);
		await approve_gate({ run_id: 'run-1', gate_id: 'gate-1' });
		expect(notifiedRun).toBe('run-1');
		expect(notifiedGate).toBe('gate-1');
	});

	it('transitions rejected run back to in_progress', async () => {
		const run = makeWorkflowRun({
			id: 'run-1',
			status: 'needs_attention',
			failureReason: 'humanRejected',
		});
		const runRepo = makeWorkflowRunRepo([run]);
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: runRepo,
			gateDataRepo: makeGateDataRepo(),
		});
		const { approve_gate } = createNeoActionToolHandlers(config);
		await approve_gate({ run_id: 'run-1', gate_id: 'gate-1' });
		expect(runRepo._runs.get('run-1')?.status).toBe('in_progress');
		expect(runRepo._runs.get('run-1')?.failureReason).toBeNull();
	});

	it('is idempotent when already approved', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'in_progress' });
		const gateRepo = makeGateDataRepo();
		// Pre-populate approved state
		gateRepo.merge('run-1', 'gate-1', { approved: true, approvedAt: 123 });
		let delegateCalls = 0;
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: makeWorkflowRunRepo([run]),
			gateDataRepo: gateRepo,
			onGateChanged: () => {
				delegateCalls++;
			},
		});
		const { approve_gate } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_gate({ run_id: 'run-1', gate_id: 'gate-1' }));
		expect(result.success).toBe(true);
		// onGateChanged should NOT be called for an idempotent approval
		expect(delegateCalls).toBe(0);
	});

	it('returns error for terminal run status', async () => {
		for (const status of ['completed', 'cancelled', 'pending']) {
			const run = makeWorkflowRun({ id: 'run-1', status });
			const config = makeConfig({
				securityMode: 'autonomous',
				workflowRunRepo: makeWorkflowRunRepo([run]),
				gateDataRepo: makeGateDataRepo(),
			});
			const { approve_gate } = createNeoActionToolHandlers(config);
			const result = parseResult(await approve_gate({ run_id: 'run-1', gate_id: 'gate-1' }));
			expect(result.success).toBe(false);
			expect(result.error).toContain(status);
		}
	});

	it('returns error when run not found', async () => {
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: makeWorkflowRunRepo(),
			gateDataRepo: makeGateDataRepo(),
		});
		const { approve_gate } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_gate({ run_id: 'missing', gate_id: 'gate-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not found');
	});

	it('requires confirmation in balanced mode (medium risk)', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'in_progress' });
		const config = makeConfig({
			securityMode: 'balanced',
			workflowRunRepo: makeWorkflowRunRepo([run]),
			gateDataRepo: makeGateDataRepo(),
		});
		const { approve_gate } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_gate({ run_id: 'run-1', gate_id: 'gate-1' }));
		expect(result.confirmationRequired).toBe(true);
		expect(result.riskLevel).toBe('medium');
	});

	it('returns error when dependencies not configured', async () => {
		const config = makeConfig({ securityMode: 'autonomous' });
		const { approve_gate } = createNeoActionToolHandlers(config);
		const result = parseResult(await approve_gate({ run_id: 'run-1', gate_id: 'gate-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not available');
	});
});

// ---------------------------------------------------------------------------
// reject_gate
// ---------------------------------------------------------------------------

describe('reject_gate', () => {
	it('writes rejected gate data and transitions run to needs_attention', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'in_progress' });
		const runRepo = makeWorkflowRunRepo([run]);
		const gateRepo = makeGateDataRepo();
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: runRepo,
			gateDataRepo: gateRepo,
		});
		const { reject_gate } = createNeoActionToolHandlers(config);
		const result = parseResult(
			await reject_gate({ run_id: 'run-1', gate_id: 'gate-1', reason: 'Not ready' })
		);
		expect(result.success).toBe(true);
		expect(result.gateData.approved).toBe(false);
		expect(result.gateData.reason).toBe('Not ready');
		expect(runRepo._runs.get('run-1')?.status).toBe('needs_attention');
		expect(runRepo._runs.get('run-1')?.failureReason).toBe('humanRejected');
	});

	it('is idempotent when already rejected', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'needs_attention' });
		const gateRepo = makeGateDataRepo();
		gateRepo.merge('run-1', 'gate-1', { approved: false, rejectedAt: 123 });
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: makeWorkflowRunRepo([run]),
			gateDataRepo: gateRepo,
		});
		const { reject_gate } = createNeoActionToolHandlers(config);
		const result = parseResult(await reject_gate({ run_id: 'run-1', gate_id: 'gate-1' }));
		expect(result.success).toBe(true);
		expect(result.gateData.approved).toBe(false);
	});

	it('does not call transitionStatus when run is already needs_attention', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'needs_attention' });
		const runRepo = makeWorkflowRunRepo([run]);
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: runRepo,
			gateDataRepo: makeGateDataRepo(),
		});
		const { reject_gate } = createNeoActionToolHandlers(config);
		await reject_gate({ run_id: 'run-1', gate_id: 'gate-1' });
		// Status remains needs_attention (not changed by the handler)
		expect(runRepo._runs.get('run-1')?.status).toBe('needs_attention');
		expect(runRepo._runs.get('run-1')?.failureReason).toBe('humanRejected');
	});

	it('stores null reason when not provided', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'in_progress' });
		const gateRepo = makeGateDataRepo();
		const config = makeConfig({
			securityMode: 'autonomous',
			workflowRunRepo: makeWorkflowRunRepo([run]),
			gateDataRepo: gateRepo,
		});
		const { reject_gate } = createNeoActionToolHandlers(config);
		const result = parseResult(await reject_gate({ run_id: 'run-1', gate_id: 'gate-1' }));
		expect(result.gateData.reason).toBeNull();
	});

	it('returns error for terminal run status', async () => {
		for (const status of ['completed', 'cancelled', 'pending']) {
			const run = makeWorkflowRun({ id: 'run-1', status });
			const config = makeConfig({
				securityMode: 'autonomous',
				workflowRunRepo: makeWorkflowRunRepo([run]),
				gateDataRepo: makeGateDataRepo(),
			});
			const { reject_gate } = createNeoActionToolHandlers(config);
			const result = parseResult(await reject_gate({ run_id: 'run-1', gate_id: 'gate-1' }));
			expect(result.success).toBe(false);
			expect(result.error).toContain(status);
		}
	});

	it('requires confirmation in balanced mode (medium risk)', async () => {
		const run = makeWorkflowRun({ id: 'run-1', status: 'in_progress' });
		const config = makeConfig({
			securityMode: 'balanced',
			workflowRunRepo: makeWorkflowRunRepo([run]),
			gateDataRepo: makeGateDataRepo(),
		});
		const { reject_gate } = createNeoActionToolHandlers(config);
		const result = parseResult(await reject_gate({ run_id: 'run-1', gate_id: 'gate-1' }));
		expect(result.confirmationRequired).toBe(true);
	});

	it('returns error when dependencies not configured', async () => {
		const config = makeConfig({ securityMode: 'autonomous' });
		const { reject_gate } = createNeoActionToolHandlers(config);
		const result = parseResult(await reject_gate({ run_id: 'run-1', gate_id: 'gate-1' }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('not available');
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

	it('registers create_space tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('create_space');
	});

	it('registers update_space tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('update_space');
	});

	it('registers delete_space tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('delete_space');
	});

	it('registers start_workflow_run tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('start_workflow_run');
	});

	it('registers cancel_workflow_run tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('cancel_workflow_run');
	});

	it('registers approve_gate tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('approve_gate');
	});

	it('registers reject_gate tool', () => {
		expect(server.instance._registeredTools).toHaveProperty('reject_gate');
	});

	it('registers exactly 18 tools', () => {
		expect(Object.keys(server.instance._registeredTools)).toHaveLength(18);
	});
});
