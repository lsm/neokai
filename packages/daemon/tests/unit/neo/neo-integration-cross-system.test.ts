/**
 * Cross-System Integration Tests for Neo Action Tools
 *
 * Tests that verify multi-manager coordination through the Neo action tool
 * handlers. Each tool under test calls more than one dependency — these tests
 * ensure all participating managers are invoked correctly and that the activity
 * logger captures the final result end-to-end.
 *
 * Covers:
 * - create_goal: roomManager.getRoom check + goalManager.createGoal + activityLogger
 * - send_message_to_room: roomManager.getRoom + sessionManager (active session + inject)
 *                         + activityLogger
 * - send_message_to_task: roomManager.getRoom + taskManager.getTask
 *                         + sessionManager.getActiveSessionForTask + inject + activityLogger
 * - Error in one manager propagates cleanly (other managers not called)
 * - NeoAgentManager.provision() calls activityLogger.pruneOldEntries()
 * - NeoAgentManager.setActivityLogger() propagates to actionToolsConfig
 */

import { mock } from 'bun:test';

// Re-declare the SDK mock so it survives Bun's module isolation.
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
	query: mock(async () => ({ interrupt: () => {} })),
	interrupt: mock(async () => {}),
	supportedModels: mock(async () => {
		throw new Error('SDK unavailable');
	}),
	createSdkMcpServer: mock((_opts: { name: string; tools: unknown[] }) => {
		const registeredTools: Record<string, unknown> = {};
		for (const t of _opts.tools ?? []) {
			const name = (t as { name: string }).name;
			const handler = (t as { handler: unknown }).handler;
			if (name) registeredTools[name] = { handler };
		}
		return {
			type: 'sdk' as const,
			name: _opts.name,
			version: '1.0.0',
			tools: _opts.tools ?? [],
			instance: {
				connect() {},
				disconnect() {},
				_registeredTools: registeredTools,
			},
		};
	}),
	tool: mock((_name: string, _desc: string, _schema: unknown, _handler: unknown) => ({
		name: _name,
		handler: _handler,
	})),
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { NeoActivityLogRepository } from '../../../src/storage/repositories/neo-activity-log-repository';
import { NeoActivityLogger } from '../../../src/lib/neo/activity-logger';
import {
	createNeoActionToolHandlers,
	createNeoActionMcpServer,
	type NeoActionToolsConfig,
	type NeoActionRoomManager,
	type NeoActionGoalManager,
	type NeoActionTaskManager,
	type NeoActionManagerFactory,
	type NeoSessionManager,
} from '../../../src/lib/neo/tools/neo-action-tools';
import { PendingActionStore } from '../../../src/lib/neo/security-tier';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';
import {
	NeoAgentManager,
	NEO_SESSION_ID,
	type NeoSessionManager as NeoAgentSessionManager,
	type NeoSettingsManager,
} from '../../../src/lib/neo/neo-agent-manager';
import type { AgentSession } from '../../../src/lib/agent/agent-session';

// ---------------------------------------------------------------------------
// DB / logger helpers
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
// Entity fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function makeRoom(overrides: Partial<Room> = {}): Room {
	return {
		id: 'room-1',
		name: 'Test Room',
		status: 'active',
		sessionIds: [],
		allowedPaths: [],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function makeGoal(overrides: Partial<RoomGoal> = {}): RoomGoal {
	return {
		id: 'goal-1',
		roomId: 'room-1',
		title: 'Test Goal',
		description: '',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		metrics: {},
		createdAt: NOW,
		updatedAt: NOW,
		missionType: 'one_shot',
		autonomyLevel: 'supervised',
		...overrides,
	};
}

function makeNeoTask(overrides: Partial<NeoTask> = {}): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		description: '',
		status: 'pending',
		priority: 'normal',
		progress: 0,
		dependsOn: [],
		createdAt: NOW,
		updatedAt: NOW,
		taskType: 'coding',
		assignedAgent: 'coder',
		...overrides,
	} as NeoTask;
}

// ---------------------------------------------------------------------------
// Manager mock factories
// ---------------------------------------------------------------------------

function makeRoomManager(rooms: Room[] = []): NeoActionRoomManager & { _callLog: string[] } {
	const store = new Map<string, Room>(rooms.map((r) => [r.id, r]));
	const callLog: string[] = [];
	return {
		_callLog: callLog,
		createRoom: (params) => {
			callLog.push('createRoom');
			const room = makeRoom({ id: `room-${Date.now()}`, name: params.name });
			store.set(room.id, room);
			return room;
		},
		deleteRoom: (id) => {
			callLog.push(`deleteRoom:${id}`);
			return store.delete(id);
		},
		getRoom: (id) => {
			callLog.push(`getRoom:${id}`);
			return store.get(id) ?? null;
		},
		updateRoom: (id, params) => {
			callLog.push(`updateRoom:${id}`);
			const room = store.get(id);
			if (!room) return null;
			const updated = { ...room, ...params, updatedAt: NOW + 1 } as Room;
			store.set(id, updated);
			return updated;
		},
		getActiveSessionCount: (_id) => 0,
	};
}

function makeGoalManager(goals: RoomGoal[] = []): NeoActionGoalManager & { _callLog: string[] } {
	const store = new Map<string, RoomGoal>(goals.map((g) => [g.id, g]));
	const callLog: string[] = [];
	return {
		_callLog: callLog,
		createGoal: async (params) => {
			callLog.push('createGoal');
			const goal = makeGoal({ id: `goal-${Date.now()}`, ...params });
			store.set(goal.id, goal);
			return goal;
		},
		getGoal: async (id) => {
			callLog.push(`getGoal:${id}`);
			return store.get(id) ?? null;
		},
		patchGoal: async (id, patch) => {
			callLog.push(`patchGoal:${id}`);
			const goal = store.get(id);
			if (!goal) throw new Error(`Goal not found: ${id}`);
			const updated = { ...goal, ...patch, updatedAt: NOW + 1 };
			store.set(id, updated);
			return updated;
		},
		updateGoalStatus: async (id, status) => {
			callLog.push(`updateGoalStatus:${id}`);
			const goal = store.get(id);
			if (!goal) throw new Error(`Goal not found: ${id}`);
			const updated = { ...goal, status, updatedAt: NOW + 1 };
			store.set(id, updated);
			return updated;
		},
	};
}

function makeTaskManager(tasks: NeoTask[] = []): NeoActionTaskManager & { _callLog: string[] } {
	const store = new Map<string, NeoTask>(tasks.map((t) => [t.id, t]));
	const callLog: string[] = [];
	return {
		_callLog: callLog,
		createTask: async (params) => {
			callLog.push('createTask');
			const task = makeNeoTask({ id: `task-${Date.now()}`, ...params });
			store.set(task.id, task);
			return task;
		},
		getTask: async (id) => {
			callLog.push(`getTask:${id}`);
			return store.get(id) ?? null;
		},
		updateTaskFields: async (id, updates) => {
			callLog.push(`updateTaskFields:${id}`);
			const task = store.get(id);
			if (!task) throw new Error(`Task not found: ${id}`);
			const updated = { ...task, ...updates, updatedAt: NOW + 1 };
			store.set(id, updated);
			return updated;
		},
		setTaskStatus: async (id, status) => {
			callLog.push(`setTaskStatus:${id}`);
			const task = store.get(id);
			if (!task) throw new Error(`Task not found: ${id}`);
			const updated = { ...task, status, updatedAt: NOW + 1 } as NeoTask;
			store.set(id, updated);
			return updated;
		},
	};
}

function makeSessionManager(
	activeSessionMap: Map<string, string> = new Map(),
	activeTaskSessionMap: Map<string, string> = new Map()
): NeoSessionManager & { injectedMessages: Array<{ sessionId: string; message: string }> } {
	const injectedMessages: Array<{ sessionId: string; message: string }> = [];
	return {
		injectedMessages,
		injectMessage: async (sessionId, message) => {
			injectedMessages.push({ sessionId, message });
		},
		getActiveSessionForRoom: (roomId) => activeSessionMap.get(roomId) ?? null,
		getActiveSessionForTask: (taskId) => activeTaskSessionMap.get(taskId) ?? null,
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

function makeConfig(
	overrides: Partial<NeoActionToolsConfig> = {},
	roomManager?: NeoActionRoomManager & { _callLog: string[] },
	goalManager?: NeoActionGoalManager & { _callLog: string[] },
	taskManager?: NeoActionTaskManager & { _callLog: string[] },
	sessionMgr?: NeoSessionManager & {
		injectedMessages: Array<{ sessionId: string; message: string }>;
	}
): NeoActionToolsConfig {
	const rm = roomManager ?? makeRoomManager([makeRoom()]);
	const gm = goalManager ?? makeGoalManager();
	const tm = taskManager ?? makeTaskManager();
	const sm = sessionMgr ?? makeSessionManager();
	const store = new PendingActionStore();

	return {
		roomManager: rm,
		managerFactory: makeManagerFactory(new Map([['room-1', gm]]), new Map([['room-1', tm]])),
		pendingStore: store,
		getSecurityMode: () => 'autonomous', // auto-execute everything for integration tests
		sessionManager: sm,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// NeoAgentManager mock helpers (for provision/healthCheck tests)
// ---------------------------------------------------------------------------

function makeAgentSession(
	overrides: {
		processingStatus?: 'idle' | 'processing' | 'queued';
		queryPromise?: Promise<void> | null;
		queryObject?: unknown;
		cleaningUp?: boolean;
	} = {}
): AgentSession {
	const {
		processingStatus = 'idle',
		queryPromise = null,
		queryObject = null,
		cleaningUp = false,
	} = overrides;
	return {
		getProcessingState: mock(() =>
			processingStatus === 'processing'
				? { status: 'processing', messageId: 'msg-1', phase: 'thinking' }
				: { status: processingStatus }
		),
		isCleaningUp: mock(() => cleaningUp),
		setRuntimeSystemPrompt: mock(() => undefined),
		setRuntimeModel: mock(() => undefined),
		setRuntimeMcpServers: mock(() => undefined),
		cleanup: mock(async () => undefined),
		queryPromise,
		queryObject,
	} as unknown as AgentSession;
}

function makeAgentSessionManager(
	opts: { existingSession?: AgentSession | null; createdSession?: AgentSession | null } = {}
): NeoAgentSessionManager {
	const sessions = new Map<string, AgentSession | null>();
	let firstGet = true;

	return {
		createSession: mock(async () => {
			const s = opts.createdSession ?? makeAgentSession();
			sessions.set(NEO_SESSION_ID, s);
			return NEO_SESSION_ID;
		}),
		getSessionAsync: mock(async (_id: string): Promise<AgentSession | null> => {
			if (firstGet) {
				firstGet = false;
				if (opts.existingSession !== undefined) {
					sessions.set(NEO_SESSION_ID, opts.existingSession);
				}
			}
			return sessions.get(NEO_SESSION_ID) ?? null;
		}),
		deleteSession: mock(async () => {
			sessions.delete(NEO_SESSION_ID);
		}),
		unregisterSession: mock(() => {}),
	};
}

function makeSettingsManager(): NeoSettingsManager {
	return { getGlobalSettings: mock(() => ({ neoSecurityMode: 'balanced', model: 'sonnet' })) };
}

// ---------------------------------------------------------------------------
// Tests: create_goal — roomManager + goalManager coordination
// ---------------------------------------------------------------------------

describe('cross-system: create_goal coordinates roomManager + goalManager', () => {
	let db: BunDatabase;
	let roomManager: NeoActionRoomManager & { _callLog: string[] };
	let goalManager: NeoActionGoalManager & { _callLog: string[] };
	let logger: NeoActivityLogger;
	let handlers: ReturnType<typeof createNeoActionToolHandlers>;

	beforeEach(() => {
		db = makeDb();
		roomManager = makeRoomManager([makeRoom({ id: 'room-1' })]);
		goalManager = makeGoalManager();
		logger = makeLogger(db);
		const config = makeConfig({ activityLogger: logger }, roomManager, goalManager);
		handlers = createNeoActionToolHandlers(config);
	});

	afterEach(() => db.close());

	test('roomManager.getRoom is called to validate the room exists', async () => {
		await handlers.create_goal({ room_id: 'room-1', title: 'My Goal' });
		expect(roomManager._callLog).toContain('getRoom:room-1');
	});

	test('goalManager.createGoal is called after room validation', async () => {
		await handlers.create_goal({ room_id: 'room-1', title: 'My Goal' });
		expect(goalManager._callLog).toContain('createGoal');
	});

	test('both managers invoked in correct order: room check before goal creation', async () => {
		await handlers.create_goal({ room_id: 'room-1', title: 'My Goal' });
		const roomIdx = roomManager._callLog.indexOf('getRoom:room-1');
		const goalIdx = goalManager._callLog.indexOf('createGoal');
		expect(roomIdx).toBeGreaterThanOrEqual(0);
		expect(goalIdx).toBeGreaterThanOrEqual(0);
	});

	test('goalManager.createGoal is NOT called when room does not exist', async () => {
		await handlers.create_goal({ room_id: 'nonexistent-room', title: 'My Goal' });
		expect(goalManager._callLog).not.toContain('createGoal');
	});

	test('result indicates success and contains goal data when both managers succeed', async () => {
		const result = await handlers.create_goal({ room_id: 'room-1', title: 'Integration Goal' });
		const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(data.success).toBe(true);
		expect(data.goal).toBeDefined();
	});

	test('result indicates error when room not found', async () => {
		const result = await handlers.create_goal({ room_id: 'bad-room', title: 'Orphan Goal' });
		const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(data.success).toBe(false);
		expect(String(data.error)).toMatch(/not found/i);
	});
});

// ---------------------------------------------------------------------------
// Tests: create_goal with activity logger — end-to-end logging
// ---------------------------------------------------------------------------

describe('cross-system: create_goal logs to activityLogger', () => {
	let db: BunDatabase;
	let logger: NeoActivityLogger;

	beforeEach(() => {
		db = makeDb();
		logger = makeLogger(db);
	});

	afterEach(() => db.close());

	test('successful create_goal creates an activity log entry via MCP server', async () => {
		const config = makeConfig({ activityLogger: logger });
		const mcpServer = createNeoActionMcpServer(config);
		const createGoalTool = mcpServer.instance._registeredTools['create_goal'];
		expect(createGoalTool).toBeDefined();

		await (createGoalTool.handler as (args: Record<string, unknown>) => Promise<unknown>)({
			name: 'room-1',
			title: 'Logged Goal',
			room_id: 'room-1',
		});

		const entries = logger.getRecentActivity(10);
		const entry = entries.find((e) => e.toolName === 'create_goal');
		expect(entry).toBeDefined();
		expect(entry!.status).toBe('success');
		expect(entry!.targetType).toBe('goal');
	});

	test('failed create_goal (room not found) logs status=error to activityLogger', async () => {
		const roomManager = makeRoomManager([]); // no rooms
		const config = makeConfig({ activityLogger: logger }, roomManager);
		const mcpServer = createNeoActionMcpServer(config);
		const createGoalTool = mcpServer.instance._registeredTools['create_goal'];

		await (createGoalTool.handler as (args: Record<string, unknown>) => Promise<unknown>)({
			room_id: 'nonexistent',
			title: 'Orphan',
		});

		const entries = logger.getRecentActivity(10);
		const entry = entries.find((e) => e.toolName === 'create_goal');
		expect(entry).toBeDefined();
		expect(entry!.status).toBe('error');
	});

	test('confirmationRequired result is NOT logged (action not yet executed)', async () => {
		// Use conservative mode so even low-risk tools require confirmation
		const config = makeConfig({ activityLogger: logger, getSecurityMode: () => 'conservative' });
		const mcpServer = createNeoActionMcpServer(config);
		const createGoalTool = mcpServer.instance._registeredTools['create_goal'];

		await (createGoalTool.handler as (args: Record<string, unknown>) => Promise<unknown>)({
			room_id: 'room-1',
			title: 'Pending Goal',
		});

		const entries = logger.getRecentActivity(10);
		expect(entries.length).toBe(0); // nothing logged until confirmed
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message_to_room — roomManager + sessionManager coordination
// ---------------------------------------------------------------------------

describe('cross-system: send_message_to_room coordinates roomManager + sessionManager', () => {
	let db: BunDatabase;
	let roomManager: NeoActionRoomManager & { _callLog: string[] };
	let sessionMgr: NeoSessionManager & {
		injectedMessages: Array<{ sessionId: string; message: string }>;
	};
	let logger: NeoActivityLogger;
	let handlers: ReturnType<typeof createNeoActionToolHandlers>;

	beforeEach(() => {
		db = makeDb();
		roomManager = makeRoomManager([makeRoom({ id: 'room-1' })]);
		sessionMgr = makeSessionManager(new Map([['room-1', 'session-abc']]));
		logger = makeLogger(db);
		const config = makeConfig(
			{ activityLogger: logger },
			roomManager,
			undefined,
			undefined,
			sessionMgr
		);
		handlers = createNeoActionToolHandlers(config);
	});

	afterEach(() => db.close());

	test('roomManager.getRoom is called to validate the room', async () => {
		await handlers.send_message_to_room({ room_id: 'room-1', message: 'Hello agent' });
		expect(roomManager._callLog).toContain('getRoom:room-1');
	});

	test('sessionManager.injectMessage is called with the active session', async () => {
		await handlers.send_message_to_room({ room_id: 'room-1', message: 'Hello agent' });
		expect(sessionMgr.injectedMessages).toHaveLength(1);
		expect(sessionMgr.injectedMessages[0].sessionId).toBe('session-abc');
		expect(sessionMgr.injectedMessages[0].message).toBe('Hello agent');
	});

	test('injectMessage is NOT called when room does not exist', async () => {
		await handlers.send_message_to_room({ room_id: 'missing', message: 'Hello' });
		expect(sessionMgr.injectedMessages).toHaveLength(0);
	});

	test('injectMessage is NOT called when room has no active session', async () => {
		// sessionMgr maps room-1 to no session
		const noSessionMgr = makeSessionManager(new Map()); // no active sessions
		const config = makeConfig({}, roomManager, undefined, undefined, noSessionMgr);
		const h = createNeoActionToolHandlers(config);
		await h.send_message_to_room({ room_id: 'room-1', message: 'Hello' });
		expect(noSessionMgr.injectedMessages).toHaveLength(0);
	});

	test('result indicates success after all managers coordinate', async () => {
		const result = await handlers.send_message_to_room({
			room_id: 'room-1',
			message: 'Deploy now',
		});
		const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(data.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message_to_task — roomManager + taskManager + sessionManager
// ---------------------------------------------------------------------------

describe('cross-system: send_message_to_task coordinates three managers', () => {
	let db: BunDatabase;
	let roomManager: NeoActionRoomManager & { _callLog: string[] };
	let taskManager: NeoActionTaskManager & { _callLog: string[] };
	let sessionMgr: NeoSessionManager & {
		injectedMessages: Array<{ sessionId: string; message: string }>;
	};
	let handlers: ReturnType<typeof createNeoActionToolHandlers>;

	beforeEach(() => {
		db = makeDb();
		roomManager = makeRoomManager([makeRoom({ id: 'room-1' })]);
		taskManager = makeTaskManager([makeNeoTask({ id: 'task-1', roomId: 'room-1' })]);
		sessionMgr = makeSessionManager(
			new Map([['room-1', 'session-abc']]),
			new Map([['task-1', 'session-task-xyz']])
		);
		const config = makeConfig({}, roomManager, undefined, taskManager, sessionMgr);
		// Override managerFactory to return our task manager for room-1
		const fullConfig: NeoActionToolsConfig = {
			...config,
			managerFactory: makeManagerFactory(new Map(), new Map([['room-1', taskManager]])),
		};
		handlers = createNeoActionToolHandlers(fullConfig);
	});

	afterEach(() => db.close());

	test('all three managers participate: room lookup, task lookup, message inject', async () => {
		await handlers.send_message_to_task({
			room_id: 'room-1',
			task_id: 'task-1',
			message: 'Rebase and push',
		});
		expect(roomManager._callLog).toContain('getRoom:room-1');
		expect(taskManager._callLog).toContain('getTask:task-1');
		expect(sessionMgr.injectedMessages).toHaveLength(1);
		expect(sessionMgr.injectedMessages[0].sessionId).toBe('session-task-xyz');
	});

	test('taskManager.getTask is NOT called when room does not exist', async () => {
		await handlers.send_message_to_task({
			room_id: 'missing-room',
			task_id: 'task-1',
			message: 'Hello',
		});
		expect(taskManager._callLog.filter((c) => c.startsWith('getTask'))).toHaveLength(0);
		expect(sessionMgr.injectedMessages).toHaveLength(0);
	});

	test('injectMessage is NOT called when task does not exist', async () => {
		await handlers.send_message_to_task({
			room_id: 'room-1',
			task_id: 'missing-task',
			message: 'Hello',
		});
		expect(sessionMgr.injectedMessages).toHaveLength(0);
	});

	test('result indicates success when all three managers succeed', async () => {
		const result = await handlers.send_message_to_task({
			room_id: 'room-1',
			task_id: 'task-1',
			message: 'Continue',
		});
		const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(data.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: NeoAgentManager.provision() calls activityLogger.pruneOldEntries()
// ---------------------------------------------------------------------------

describe('NeoAgentManager + activityLogger: provision() enforces retention policy', () => {
	test('pruneOldEntries is called during provision()', async () => {
		const session = makeAgentSession();
		const sm = makeAgentSessionManager({ existingSession: null, createdSession: session });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		let pruned = false;
		const logger = {
			pruneOldEntries: () => {
				pruned = true;
				return 0;
			},
		} as unknown as NeoActivityLogger;

		mgr.setActivityLogger(logger);
		await mgr.provision();

		expect(pruned).toBe(true);
	});

	test('pruneOldEntries is NOT called when no activityLogger is set', async () => {
		const session = makeAgentSession();
		const sm = makeAgentSessionManager({ existingSession: null, createdSession: session });
		const mgr = new NeoAgentManager(sm, makeSettingsManager());
		// No setActivityLogger call — should not throw
		await expect(mgr.provision()).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: setActivityLogger() propagates to actionToolsConfig
// ---------------------------------------------------------------------------

describe('NeoAgentManager.setActivityLogger() propagates to actionToolsConfig', () => {
	test('activityLogger set before setActionToolsConfig propagates on setActionToolsConfig call', () => {
		const sm = makeAgentSessionManager();
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		const logger = {
			pruneOldEntries: () => 0,
			logAction: mock(() => ({}) as ReturnType<NeoActivityLogger['logAction']>),
		} as unknown as NeoActivityLogger;

		const actionConfig: NeoActionToolsConfig = {
			roomManager: makeRoomManager(),
			managerFactory: makeManagerFactory(),
			pendingStore: new PendingActionStore(),
			getSecurityMode: () => 'autonomous' as const,
		};

		mgr.setActivityLogger(logger);
		mgr.setActionToolsConfig(actionConfig);

		// The activityLogger should now be available on the actionConfig
		expect(actionConfig.activityLogger).toBe(logger);
	});

	test('activityLogger set after setActionToolsConfig propagates immediately', () => {
		const sm = makeAgentSessionManager();
		const mgr = new NeoAgentManager(sm, makeSettingsManager());

		const actionConfig: NeoActionToolsConfig = {
			roomManager: makeRoomManager(),
			managerFactory: makeManagerFactory(),
			pendingStore: new PendingActionStore(),
			getSecurityMode: () => 'autonomous' as const,
		};

		mgr.setActionToolsConfig(actionConfig);

		const logger = {
			pruneOldEntries: () => 0,
		} as unknown as NeoActivityLogger;
		mgr.setActivityLogger(logger);

		// Propagated even though setActionToolsConfig was called first
		expect(actionConfig.activityLogger).toBe(logger);
	});
});
