/**
 * Unit tests for undo_last_action tool
 *
 * Covers:
 * - no activity logger → error
 * - no undoable entries → error
 * - corrupt undo data → error
 * - create_room undo → deletes room
 * - update_room_settings undo → restores previous settings
 * - create_goal undo with deleteGoal → deletes goal
 * - create_goal undo without deleteGoal → archives goal
 * - set_goal_status undo → restores previous status
 * - create_task undo with deleteTask → deletes task
 * - create_task undo without deleteTask → cancels task
 * - set_task_status undo → restores previous status
 * - toggle_skill undo → restores previous enabled state
 * - toggle_mcp_server undo → restores previous enabled state
 * - update_app_settings undo → restores previous settings
 * - undo marks original entry as non-undoable (prevents double-undo)
 * - undo logs the undo action as activity entry
 * - target no longer exists → error (room, goal, task, skill, mcp server)
 * - unknown toolName → error
 * - missing required fields in undoData → error
 * - security check: confirmation required in balanced mode
 * - security check: auto-execute in autonomous mode
 * - MCP server: undo_last_action tool is registered
 * - NeoActivityLogger.markUndone() sets undoable to false
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../../src/storage/schema';
import { NeoActivityLogRepository } from '../../../../src/storage/repositories/neo-activity-log-repository';
import { NeoActivityLogger } from '../../../../src/lib/neo/activity-logger';
import {
	createNeoActionToolHandlers,
	createNeoActionMcpServer, // used in MCP registration test
	type NeoActionToolsConfig,
	type NeoActionRoomManager,
	type NeoActionGoalManager,
	type NeoActionTaskManager,
	type NeoActionManagerFactory,
	type NeoMcpManager,
	type NeoSkillsManager,
	type NeoSettingsManager,
} from '../../../../src/lib/neo/tools/neo-action-tools';
import { PendingActionStore } from '../../../../src/lib/neo/security-tier';
import type {
	Room,
	RoomGoal,
	NeoTask,
	AppMcpServer,
	AppSkill,
	GlobalSettings,
} from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB + Logger helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	createTables(db);
	return db;
}

function makeLogger(db: BunDatabase): NeoActivityLogger {
	return new NeoActivityLogger(new NeoActivityLogRepository(db));
}

// ---------------------------------------------------------------------------
// Fixture factories
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

function makeAppSkill(overrides: Partial<AppSkill> = {}): AppSkill {
	return {
		id: 'skill-1',
		name: 'test-skill',
		displayName: 'Test Skill',
		description: 'A test skill',
		sourceType: 'plugin',
		config: { type: 'plugin', pluginPath: '/path/to/plugin' },
		enabled: false,
		builtIn: false,
		validationStatus: 'pending',
		createdAt: NOW,
		...overrides,
	};
}

function makeMcpServer(overrides: Partial<AppMcpServer> = {}): AppMcpServer {
	return {
		id: 'mcp-1',
		name: 'test-server',
		sourceType: 'stdio',
		enabled: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock manager factories
// ---------------------------------------------------------------------------

function makeRoomManager(
	rooms: Room[] = [],
	opts: { activeSessions?: Map<string, number> } = {}
): NeoActionRoomManager {
	const store = new Map<string, Room>(rooms.map((r) => [r.id, r]));
	return {
		createRoom: (params) => {
			const room = makeRoom({ id: `room-${Date.now()}`, name: params.name });
			store.set(room.id, room);
			return room;
		},
		deleteRoom: (id) => {
			if (!store.has(id)) return false;
			store.delete(id);
			return true;
		},
		getRoom: (id) => store.get(id) ?? null,
		getActiveSessionCount: opts.activeSessions
			? (id) => opts.activeSessions!.get(id) ?? 0
			: undefined,
		updateRoom: (id, params) => {
			const room = store.get(id);
			if (!room) return null;
			const updated = { ...room, ...params, updatedAt: NOW + 1 } as Room;
			store.set(id, updated);
			return updated;
		},
	};
}

function makeGoalManager(
	goals: RoomGoal[] = [],
	opts: { hasDelete?: boolean } = {}
): NeoActionGoalManager {
	const store = new Map<string, RoomGoal>(goals.map((g) => [g.id, g]));
	const mgr: NeoActionGoalManager = {
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
		updateGoalStatus: async (id, status, updates) => {
			const goal = store.get(id);
			if (!goal) throw new Error(`Goal not found: ${id}`);
			const updated = { ...goal, status, ...updates, updatedAt: NOW + 1 };
			store.set(id, updated);
			return updated;
		},
	};
	if (opts.hasDelete) {
		mgr.deleteGoal = async (id) => {
			if (!store.has(id)) return false;
			store.delete(id);
			return true;
		};
	}
	return mgr;
}

function makeTaskManager(
	tasks: NeoTask[] = [],
	opts: { hasDelete?: boolean } = {}
): NeoActionTaskManager {
	const store = new Map<string, NeoTask>(tasks.map((t) => [t.id, t]));
	const mgr: NeoActionTaskManager = {
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
	if (opts.hasDelete) {
		mgr.deleteTask = async (id) => {
			if (!store.has(id)) return false;
			store.delete(id);
			return true;
		};
	}
	return mgr;
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

function makeSkillsManager(skills: AppSkill[] = []): NeoSkillsManager {
	const store = new Map<string, AppSkill>(skills.map((s) => [s.id, s]));
	return {
		addSkill: (params) => {
			const skill = makeAppSkill({ id: `skill-${Date.now()}`, ...params });
			store.set(skill.id, skill);
			return skill;
		},
		updateSkill: (id, params) => {
			const skill = store.get(id);
			if (!skill) throw new Error(`Skill not found: ${id}`);
			const updated = { ...skill, ...params };
			store.set(id, updated);
			return updated;
		},
		setSkillEnabled: (id, enabled) => {
			const skill = store.get(id);
			if (!skill) throw new Error(`Skill not found: ${id}`);
			const updated = { ...skill, enabled };
			store.set(id, updated);
			return updated;
		},
		removeSkill: (id) => {
			if (!store.has(id)) return false;
			store.delete(id);
			return true;
		},
		getSkill: (id) => store.get(id) ?? null,
	};
}

function makeMcpManager(servers: AppMcpServer[] = []): NeoMcpManager {
	const store = new Map<string, AppMcpServer>(servers.map((s) => [s.id, s]));
	return {
		createMcpServer: (params) => {
			const server: AppMcpServer = {
				id: `mcp-${Date.now()}`,
				name: params.name,
				sourceType: params.sourceType,
				enabled: params.enabled ?? false,
			};
			store.set(server.id, server);
			return server;
		},
		updateMcpServer: (id, updates) => {
			const s = store.get(id);
			if (!s) return null;
			const updated = { ...s, ...updates };
			store.set(id, updated);
			return updated;
		},
		deleteMcpServer: (id) => {
			if (!store.has(id)) return false;
			store.delete(id);
			return true;
		},
		getMcpServer: (id) => store.get(id) ?? null,
		getMcpServerByName: (name) => Array.from(store.values()).find((s) => s.name === name) ?? null,
	};
}

function makeSettingsManager(initial: Partial<GlobalSettings> = {}): NeoSettingsManager {
	let settings: GlobalSettings = {
		model: 'claude-sonnet-4-6',
		thinkingLevel: 'none',
		autoScroll: true,
		maxConcurrentWorkers: 3,
		...initial,
	} as GlobalSettings;
	return {
		getGlobalSettings: () => settings,
		updateGlobalSettings: (updates) => {
			settings = { ...settings, ...updates };
			return settings;
		},
	};
}

// ---------------------------------------------------------------------------
// Helper to build config with an activity logger
// ---------------------------------------------------------------------------

function makeConfig(
	opts: {
		db?: BunDatabase;
		rooms?: Room[];
		activeSessions?: Map<string, number>;
		goals?: RoomGoal[];
		tasks?: NeoTask[];
		skills?: AppSkill[];
		servers?: AppMcpServer[];
		goalManagerOpts?: { hasDelete?: boolean };
		taskManagerOpts?: { hasDelete?: boolean };
		settingsOpts?: Partial<GlobalSettings>;
		noLogger?: boolean;
		mode?: 'balanced' | 'autonomous' | 'conservative';
	} = {}
): {
	config: NeoActionToolsConfig;
	roomManager: NeoActionRoomManager;
	goalManager: NeoActionGoalManager;
	taskManager: NeoActionTaskManager;
	skillsManager: NeoSkillsManager;
	mcpManager: NeoMcpManager;
	settingsManager: NeoSettingsManager;
	logger: NeoActivityLogger | undefined;
} {
	const db = opts.db ?? makeDb();
	const logger = opts.noLogger ? undefined : makeLogger(db);
	const roomManager = makeRoomManager(opts.rooms ?? [makeRoom()], {
		activeSessions: opts.activeSessions,
	});
	const goalManager = makeGoalManager(opts.goals ?? [], opts.goalManagerOpts);
	const taskManager = makeTaskManager(opts.tasks ?? [], opts.taskManagerOpts);
	const skillsManager = makeSkillsManager(opts.skills ?? []);
	const mcpManager = makeMcpManager(opts.servers ?? []);
	const settingsManager = makeSettingsManager(opts.settingsOpts);
	const managerFactory = makeManagerFactory(
		new Map([['room-1', goalManager]]),
		new Map([['room-1', taskManager]])
	);
	const config: NeoActionToolsConfig = {
		roomManager,
		managerFactory,
		pendingStore: new PendingActionStore(),
		getSecurityMode: () => opts.mode ?? 'autonomous',
		skillsManager,
		mcpManager,
		settingsManager,
		activityLogger: logger,
	};
	return {
		config,
		roomManager,
		goalManager,
		taskManager,
		skillsManager,
		mcpManager,
		settingsManager,
		logger,
	};
}

// Helper to parse tool result JSON
function parseResult(result: { content: Array<{ type: string; text: string }> }) {
	return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// NeoActivityLogger.markUndone()
// ---------------------------------------------------------------------------

describe('NeoActivityLogger.markUndone()', () => {
	it('sets undoable to false on an existing entry', () => {
		const db = makeDb();
		const repo = new NeoActivityLogRepository(db);
		const logger = new NeoActivityLogger(repo);

		logger.logAction({
			toolName: 'toggle_skill',
			input: { skill_id: 'sk-1', enabled: true },
			status: 'success',
			undoable: true,
			undoData: { skillId: 'sk-1', previousEnabled: false },
		});

		const entry = logger.getLatestUndoable();
		expect(entry).not.toBeNull();

		logger.markUndone(entry!.id);

		expect(logger.getLatestUndoable()).toBeNull();
		db.close();
	});

	it('is a no-op for a non-existent ID', () => {
		const db = makeDb();
		const logger = makeLogger(db);
		// Should not throw
		expect(() => logger.markUndone('nonexistent-id')).not.toThrow();
		db.close();
	});
});

// ---------------------------------------------------------------------------
// undo_last_action handler
// ---------------------------------------------------------------------------

describe('undo_last_action', () => {
	describe('pre-conditions', () => {
		it('returns error when activity logger is not configured', async () => {
			const { config } = makeConfig({ noLogger: true });
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/activity logging/i);
		});

		it('returns error when there are no undoable entries', async () => {
			const { config, logger } = makeConfig();
			// Log a non-undoable entry
			logger!.logAction({ toolName: 'delete_room', input: {}, status: 'success', undoable: false });
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/nothing to undo/i);
		});

		it('returns error when undo data is corrupt JSON', async () => {
			const db = makeDb();
			const repo = new NeoActivityLogRepository(db);
			const logger = new NeoActivityLogger(repo);
			// Manually insert an entry with invalid undo data
			repo.insert({
				id: 'bad-entry',
				toolName: 'toggle_skill',
				input: '{}',
				status: 'success',
				undoable: true,
				undoData: 'INVALID_JSON{{{',
			});

			const { config } = makeConfig({ db });
			// Override with this specific logger
			config.activityLogger = logger;
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/corrupt/i);
			db.close();
		});
	});

	describe('create_room undo', () => {
		it('deletes the created room', async () => {
			const room = makeRoom({ id: 'new-room' });
			const { config, roomManager, logger } = makeConfig({ rooms: [room] });
			logger!.logAction({
				toolName: 'create_room',
				input: { name: 'New Room' },
				status: 'success',
				undoable: true,
				undoData: { roomId: 'new-room' },
			});
			expect(roomManager.getRoom('new-room')).not.toBeNull();
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			expect(result.undoneToolName).toBe('create_room');
			expect(roomManager.getRoom('new-room')).toBeNull();
		});

		it('returns error when room no longer exists', async () => {
			const { config, logger } = makeConfig({ rooms: [] });
			logger!.logAction({
				toolName: 'create_room',
				input: { name: 'Gone Room' },
				status: 'success',
				undoable: true,
				undoData: { roomId: 'gone-room' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no longer exists/i);
		});

		it('returns error when room has active sessions (mirrors delete_room safety check)', async () => {
			const room = makeRoom({ id: 'busy-room' });
			const { config, roomManager, logger } = makeConfig({
				rooms: [room],
				activeSessions: new Map([['busy-room', 2]]),
			});
			logger!.logAction({
				toolName: 'create_room',
				input: { name: 'Busy Room' },
				status: 'success',
				undoable: true,
				undoData: { roomId: 'busy-room' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/active session/i);
			// Room must NOT be deleted
			expect(roomManager.getRoom('busy-room')).not.toBeNull();
		});

		it('returns error when roomId missing from undoData', async () => {
			const { config, logger } = makeConfig();
			logger!.logAction({
				toolName: 'create_room',
				input: {},
				status: 'success',
				undoable: true,
				undoData: {},
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/missing roomid/i);
		});
	});

	describe('update_room_settings undo', () => {
		it('restores previous room settings', async () => {
			const room = makeRoom({ id: 'room-1', name: 'New Name', background: 'New Bg' });
			const { config, roomManager, logger } = makeConfig({ rooms: [room] });
			logger!.logAction({
				toolName: 'update_room_settings',
				input: { room_id: 'room-1', name: 'New Name' },
				status: 'success',
				undoable: true,
				undoData: {
					roomId: 'room-1',
					previousName: 'Old Name',
					previousBackground: 'Old Bg',
					previousInstructions: null,
					previousDefaultModel: null,
					previousAllowedModels: [],
				},
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			const restored = roomManager.getRoom('room-1');
			expect(restored?.name).toBe('Old Name');
			expect(restored?.background).toBe('Old Bg');
		});

		it('returns error when room no longer exists', async () => {
			const { config, logger } = makeConfig({ rooms: [] });
			logger!.logAction({
				toolName: 'update_room_settings',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { roomId: 'gone-room', previousName: 'Old' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no longer exists/i);
		});
	});

	describe('create_goal undo', () => {
		it('hard-deletes goal when deleteGoal is available', async () => {
			const goal = makeGoal({ id: 'goal-1' });
			const { config, goalManager, logger } = makeConfig({
				goals: [goal],
				goalManagerOpts: { hasDelete: true },
			});
			logger!.logAction({
				toolName: 'create_goal',
				input: { room_id: 'room-1', title: 'My Goal' },
				status: 'success',
				undoable: true,
				undoData: { goalId: 'goal-1', roomId: 'room-1' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			expect(await goalManager.getGoal('goal-1')).toBeNull();
		});

		it('archives goal when deleteGoal is not available', async () => {
			const goal = makeGoal({ id: 'goal-1', status: 'active' });
			const { config, goalManager, logger } = makeConfig({ goals: [goal] });
			logger!.logAction({
				toolName: 'create_goal',
				input: { room_id: 'room-1', title: 'My Goal' },
				status: 'success',
				undoable: true,
				undoData: { goalId: 'goal-1', roomId: 'room-1' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			const restored = await goalManager.getGoal('goal-1');
			expect(restored?.status).toBe('archived');
		});

		it('returns error when goal no longer exists', async () => {
			const { config, logger } = makeConfig({ goals: [] });
			logger!.logAction({
				toolName: 'create_goal',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { goalId: 'gone-goal', roomId: 'room-1' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no longer exists/i);
		});
	});

	describe('set_goal_status undo', () => {
		it('restores previous goal status', async () => {
			const goal = makeGoal({ id: 'goal-1', status: 'completed' });
			const { config, goalManager, logger } = makeConfig({ goals: [goal] });
			logger!.logAction({
				toolName: 'set_goal_status',
				input: { room_id: 'room-1', goal_id: 'goal-1', status: 'completed' },
				status: 'success',
				undoable: true,
				undoData: { goalId: 'goal-1', roomId: 'room-1', previousStatus: 'active' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			const restored = await goalManager.getGoal('goal-1');
			expect(restored?.status).toBe('active');
		});

		it('returns error when goal no longer exists', async () => {
			const { config, logger } = makeConfig({ goals: [] });
			logger!.logAction({
				toolName: 'set_goal_status',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { goalId: 'gone-goal', roomId: 'room-1', previousStatus: 'active' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no longer exists/i);
		});
	});

	describe('create_task undo', () => {
		it('hard-deletes task when deleteTask is available', async () => {
			const task = makeTask({ id: 'task-1' });
			const { config, taskManager, logger } = makeConfig({
				tasks: [task],
				taskManagerOpts: { hasDelete: true },
			});
			logger!.logAction({
				toolName: 'create_task',
				input: { room_id: 'room-1', title: 'My Task', description: 'Do stuff' },
				status: 'success',
				undoable: true,
				undoData: { taskId: 'task-1', roomId: 'room-1' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			expect(await taskManager.getTask('task-1')).toBeNull();
		});

		it('cancels task when deleteTask is not available', async () => {
			const task = makeTask({ id: 'task-1', status: 'pending' });
			const { config, taskManager, logger } = makeConfig({ tasks: [task] });
			logger!.logAction({
				toolName: 'create_task',
				input: { room_id: 'room-1', title: 'My Task', description: 'Do stuff' },
				status: 'success',
				undoable: true,
				undoData: { taskId: 'task-1', roomId: 'room-1' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			const restored = await taskManager.getTask('task-1');
			expect(restored?.status).toBe('cancelled');
		});

		it('returns error when task no longer exists', async () => {
			const { config, logger } = makeConfig({ tasks: [] });
			logger!.logAction({
				toolName: 'create_task',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { taskId: 'gone-task', roomId: 'room-1' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no longer exists/i);
		});
	});

	describe('set_task_status undo', () => {
		it('restores previous task status', async () => {
			const task = makeTask({ id: 'task-1', status: 'completed' });
			const { config, taskManager, logger } = makeConfig({ tasks: [task] });
			logger!.logAction({
				toolName: 'set_task_status',
				input: { room_id: 'room-1', task_id: 'task-1', status: 'completed' },
				status: 'success',
				undoable: true,
				undoData: { taskId: 'task-1', roomId: 'room-1', previousStatus: 'in_progress' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			const restored = await taskManager.getTask('task-1');
			expect(restored?.status).toBe('in_progress');
		});

		it('returns error when task no longer exists', async () => {
			const { config, logger } = makeConfig({ tasks: [] });
			logger!.logAction({
				toolName: 'set_task_status',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { taskId: 'gone-task', roomId: 'room-1', previousStatus: 'pending' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no longer exists/i);
		});
	});

	describe('toggle_skill undo', () => {
		it('restores previous enabled state (true → false)', async () => {
			const skill = makeAppSkill({ id: 'skill-1', enabled: true });
			const { config, skillsManager, logger } = makeConfig({ skills: [skill] });
			logger!.logAction({
				toolName: 'toggle_skill',
				input: { skill_id: 'skill-1', enabled: true },
				status: 'success',
				undoable: true,
				undoData: { skillId: 'skill-1', previousEnabled: false },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			expect(skillsManager.getSkill('skill-1')?.enabled).toBe(false);
		});

		it('restores previous enabled state (false → true)', async () => {
			const skill = makeAppSkill({ id: 'skill-1', enabled: false });
			const { config, skillsManager, logger } = makeConfig({ skills: [skill] });
			logger!.logAction({
				toolName: 'toggle_skill',
				input: { skill_id: 'skill-1', enabled: false },
				status: 'success',
				undoable: true,
				undoData: { skillId: 'skill-1', previousEnabled: true },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			expect(skillsManager.getSkill('skill-1')?.enabled).toBe(true);
		});

		it('returns error when skills manager not available', async () => {
			const { config, logger } = makeConfig();
			config.skillsManager = undefined;
			logger!.logAction({
				toolName: 'toggle_skill',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { skillId: 'skill-1', previousEnabled: false },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/skills manager not available/i);
		});

		it('returns error when skill no longer exists', async () => {
			const { config, logger } = makeConfig({ skills: [] });
			logger!.logAction({
				toolName: 'toggle_skill',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { skillId: 'gone-skill', previousEnabled: false },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no longer exists/i);
		});
	});

	describe('toggle_mcp_server undo', () => {
		it('restores previous enabled state', async () => {
			const server = makeMcpServer({ id: 'mcp-1', enabled: true });
			const { config, mcpManager, logger } = makeConfig({ servers: [server] });
			logger!.logAction({
				toolName: 'toggle_mcp_server',
				input: { server_id: 'mcp-1', enabled: true },
				status: 'success',
				undoable: true,
				undoData: { serverId: 'mcp-1', previousEnabled: false },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			expect(mcpManager.getMcpServer('mcp-1')?.enabled).toBe(false);
		});

		it('returns error when MCP manager not available', async () => {
			const { config, logger } = makeConfig();
			config.mcpManager = undefined;
			logger!.logAction({
				toolName: 'toggle_mcp_server',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { serverId: 'mcp-1', previousEnabled: false },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/mcp manager not available/i);
		});

		it('returns error when server no longer exists', async () => {
			const { config, logger } = makeConfig({ servers: [] });
			logger!.logAction({
				toolName: 'toggle_mcp_server',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { serverId: 'gone-server', previousEnabled: false },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no longer exists/i);
		});
	});

	describe('update_app_settings undo', () => {
		it('restores previous settings values', async () => {
			const { config, settingsManager, logger } = makeConfig({
				settingsOpts: { model: 'claude-opus-4-6', autoScroll: false },
			});
			logger!.logAction({
				toolName: 'update_app_settings',
				input: { model: 'claude-opus-4-6' },
				status: 'success',
				undoable: true,
				undoData: { previousSettings: { model: 'claude-sonnet-4-6' } },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			expect(settingsManager.getGlobalSettings().model).toBe('claude-sonnet-4-6');
		});

		it('restores multiple settings fields', async () => {
			const { config, settingsManager, logger } = makeConfig({
				settingsOpts: { autoScroll: false, maxConcurrentWorkers: 10 },
			});
			logger!.logAction({
				toolName: 'update_app_settings',
				input: { auto_scroll: false, max_concurrent_workers: 10 },
				status: 'success',
				undoable: true,
				undoData: {
					previousSettings: { autoScroll: true, maxConcurrentWorkers: 3 },
				},
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			const settings = settingsManager.getGlobalSettings();
			expect(settings.autoScroll).toBe(true);
			expect(settings.maxConcurrentWorkers).toBe(3);
		});

		it('returns error when settings manager not available', async () => {
			const { config, logger } = makeConfig();
			config.settingsManager = undefined;
			logger!.logAction({
				toolName: 'update_app_settings',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { previousSettings: { model: 'claude-sonnet-4-6' } },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/settings manager not available/i);
		});

		it('returns error when previousSettings missing from undoData', async () => {
			const { config, logger } = makeConfig();
			logger!.logAction({
				toolName: 'update_app_settings',
				input: {},
				status: 'success',
				undoable: true,
				undoData: {},
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/missing previoussettings/i);
		});
	});

	describe('unknown toolName', () => {
		it('returns error for unrecognized tool name', async () => {
			const { config, logger } = makeConfig();
			logger!.logAction({
				toolName: 'some_future_tool',
				input: {},
				status: 'success',
				undoable: true,
				undoData: { some: 'data' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no undo handler/i);
		});
	});

	describe('side effects after undo', () => {
		it('marks the original entry as non-undoable after successful undo', async () => {
			const room = makeRoom({ id: 'new-room' });
			const { config, logger } = makeConfig({ rooms: [room] });
			logger!.logAction({
				toolName: 'create_room',
				input: { name: 'New Room' },
				status: 'success',
				undoable: true,
				undoData: { roomId: 'new-room' },
			});

			expect(logger!.getLatestUndoable()).not.toBeNull();

			const handlers = createNeoActionToolHandlers(config);
			await handlers.undo_last_action();

			// After undo, the entry should no longer be undoable
			expect(logger!.getLatestUndoable()).toBeNull();
		});

		it('does NOT mark original as undone when undo fails', async () => {
			const { config, logger } = makeConfig({ rooms: [] });
			// Log an entry that will fail to undo (room doesn't exist)
			logger!.logAction({
				toolName: 'create_room',
				input: { name: 'Gone' },
				status: 'success',
				undoable: true,
				undoData: { roomId: 'gone-room' },
			});

			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(false);

			// The entry should still be undoable (user can investigate and retry manually)
			expect(logger!.getLatestUndoable()).not.toBeNull();
		});

		it('original create_room entry remains in feed (not deleted) after undo', async () => {
			const db = makeDb();
			const logger = makeLogger(db);
			const room = makeRoom({ id: 'new-room' });
			const { config } = makeConfig({ db, rooms: [room] });
			config.activityLogger = logger;

			logger.logAction({
				toolName: 'create_room',
				input: { name: 'New Room' },
				status: 'success',
				undoable: true,
				undoData: { roomId: 'new-room' },
			});

			const handlers = createNeoActionToolHandlers(config);
			await handlers.undo_last_action();

			// The original create_room entry is still in the feed (activity entries are not deleted),
			// but it is now marked as non-undoable.
			const entries = logger.getRecentActivity(10);
			expect(entries).toHaveLength(1);
			expect(entries[0].toolName).toBe('create_room');
			expect(entries[0].undoable).toBe(false);
			db.close();
		});
	});

	describe('security tier enforcement', () => {
		it('returns confirmationRequired in balanced mode (high risk)', async () => {
			const room = makeRoom({ id: 'room-new' });
			const { config, logger } = makeConfig({ rooms: [room], mode: 'balanced' });
			logger!.logAction({
				toolName: 'create_room',
				input: { name: 'New Room' },
				status: 'success',
				undoable: true,
				undoData: { roomId: 'room-new' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.confirmationRequired).toBe(true);
			expect(result.pendingActionId).toBeDefined();
			// Room should NOT be deleted yet
			expect(config.roomManager.getRoom('room-new')).not.toBeNull();
		});

		it('auto-executes in autonomous mode', async () => {
			const room = makeRoom({ id: 'room-auto' });
			const { config, logger } = makeConfig({ rooms: [room], mode: 'autonomous' });
			logger!.logAction({
				toolName: 'create_room',
				input: { name: 'New Room' },
				status: 'success',
				undoable: true,
				undoData: { roomId: 'room-auto' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.success).toBe(true);
			expect(config.roomManager.getRoom('room-auto')).toBeNull();
		});

		it('returns confirmationRequired in conservative mode', async () => {
			const room = makeRoom({ id: 'room-cons' });
			const { config, logger } = makeConfig({ rooms: [room], mode: 'conservative' });
			logger!.logAction({
				toolName: 'create_room',
				input: { name: 'New Room' },
				status: 'success',
				undoable: true,
				undoData: { roomId: 'room-cons' },
			});
			const handlers = createNeoActionToolHandlers(config);
			const result = parseResult(await handlers.undo_last_action());
			expect(result.confirmationRequired).toBe(true);
		});
	});
});

// ---------------------------------------------------------------------------
// MCP server registration
// ---------------------------------------------------------------------------

describe('createNeoActionMcpServer: undo_last_action registration', () => {
	it('registers the undo_last_action tool', () => {
		const { config } = makeConfig();
		const server = createNeoActionMcpServer(config);
		expect(server.instance._registeredTools).toHaveProperty('undo_last_action');
	});

	it('undo_last_action produces an activity log entry via the logged() wrapper', async () => {
		const db = makeDb();
		const logger = makeLogger(db);
		const room = makeRoom({ id: 'room-to-undo' });
		const { config } = makeConfig({ db, rooms: [room] });
		config.activityLogger = logger;

		// Seed a create_room entry so there is something to undo.
		logger.logAction({
			toolName: 'create_room',
			input: { name: 'Room To Undo' },
			status: 'success',
			undoable: true,
			undoData: { roomId: 'room-to-undo' },
		});

		// Call undo through the MCP server so the logged() wrapper runs.
		const server = createNeoActionMcpServer(config);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const reg = (server as any).instance._registeredTools as Record<
			string,
			{ handler: (args: Record<string, unknown>) => Promise<unknown> }
		>;
		await reg['undo_last_action'].handler({});

		// Should now have 2 entries: original create_room (undoable=false) + undo_last_action.
		const entries = logger.getRecentActivity(10);
		expect(entries).toHaveLength(2);

		// Ordering can tie on timestamp in fast test runs; assert by tool identity.
		const undoEntry = entries.find((entry) => entry.toolName === 'undo_last_action');
		expect(undoEntry).toBeDefined();
		expect(undoEntry?.undoable).toBe(false);

		const createRoomEntry = entries.find((entry) => entry.toolName === 'create_room');
		expect(createRoomEntry).toBeDefined();
		expect(createRoomEntry?.undoable).toBe(false);
		db.close();
	});
});
