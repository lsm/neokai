import { describe, expect, it, beforeEach, mock, afterEach, spyOn } from 'bun:test';
import { AgentSession } from '../../../src/lib/agent/agent-session';
import { Database } from 'bun:sqlite';
import {
	RoomRuntimeService,
	type RoomRuntimeServiceConfig,
} from '../../../src/lib/room/runtime/room-runtime-service';
import { RoomRuntime } from '../../../src/lib/room/runtime/room-runtime';
import { SessionObserver } from '../../../src/lib/room/state/session-observer';
import { SessionGroupRepository } from '../../../src/lib/room/state/session-group-repository';
import { TaskManager } from '../../../src/lib/room/managers/task-manager';
import { GoalManager } from '../../../src/lib/room/managers/goal-manager';
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';
import type { SessionFactory } from '../../../src/lib/room/runtime/task-group-manager';
import type { Room } from '@neokai/shared';
import { noOpReactiveDb } from '../../helpers/reactive-database';
import type { SettingsManager } from '../../../src/lib/settings-manager';

describe('RoomRuntimeService', () => {
	let service: RoomRuntimeService;
	let mockRoomManager: RoomManager;
	let mockSettingsManager: SettingsManager;

	// Helper to create a room mock.
	// All rooms must have defaultPath set (post backfill-migration). Tests pass '/tmp' as the
	// default so they don't exercise the legacy undefined path fallback.
	function makeRoom(overrides: Partial<Room> = {}): Room {
		return {
			id: 'room-1',
			name: 'Test Room',
			allowedPaths: [{ path: '/tmp' }],
			defaultPath: '/tmp',
			defaultModel: undefined,
			allowedModels: undefined,
			sessionIds: [],
			status: 'active',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...overrides,
		};
	}

	beforeEach(() => {
		mockRoomManager = {
			getRoom: () => null,
		} as unknown as RoomManager;

		mockSettingsManager = {
			getEnabledMcpServersConfig: mock(() => ({})),
		} as unknown as SettingsManager;

		const config: RoomRuntimeServiceConfig = {
			db: {} as never,
			messageHub: {} as never,
			daemonHub: {} as never,
			getApiKey: async () => null,
			roomManager: mockRoomManager,
			sessionManager: { registerSession: () => {}, unregisterSession: () => {} } as never,
			defaultWorkspacePath: '/tmp',
			defaultModel: 'global-default-model',
			getGlobalSettings: () => ({}) as never,
			settingsManager: mockSettingsManager,
			reactiveDb: {} as never,
		};

		service = new RoomRuntimeService(config);
	});

	describe('getLeaderModel', () => {
		it('should return null for non-existent room', () => {
			const result = service.getLeaderModel('non-existent');
			expect(result).toBeNull();
		});

		it('should return global default when room has no defaultModel and no agentModels', () => {
			mockRoomManager.getRoom = () => makeRoom();

			const result = service.getLeaderModel('room-1');
			expect(result).toBe('global-default-model');
		});

		it('should return room.defaultModel when agentModels.leader is not set', () => {
			mockRoomManager.getRoom = () => makeRoom({ defaultModel: 'room-default-model' });

			const result = service.getLeaderModel('room-1');
			expect(result).toBe('room-default-model');
		});

		it('should prefer agentModels.leader over room.defaultModel', () => {
			mockRoomManager.getRoom = () =>
				makeRoom({
					defaultModel: 'room-default-model',
					config: { agentModels: { leader: 'leader-specific-model' } },
				});

			const result = service.getLeaderModel('room-1');
			expect(result).toBe('leader-specific-model');
		});

		it('should use agentModels.leader even when empty string (explicit override)', () => {
			mockRoomManager.getRoom = () =>
				makeRoom({
					defaultModel: 'room-default-model',
					config: { agentModels: { leader: '' } },
				});

			const result = service.getLeaderModel('room-1');
			// Empty string is a valid value - intentional override
			expect(result).toBe('');
		});
	});

	describe('getWorkerModel', () => {
		it('should return null for non-existent room', () => {
			const result = service.getWorkerModel('non-existent');
			expect(result).toBeNull();
		});

		it('should return global default when room has no defaultModel and no agentModels', () => {
			mockRoomManager.getRoom = () => makeRoom();

			const result = service.getWorkerModel('room-1');
			expect(result).toBe('global-default-model');
		});

		it('should return room.defaultModel when agentModels.worker is not set', () => {
			mockRoomManager.getRoom = () => makeRoom({ defaultModel: 'room-default-model' });

			const result = service.getWorkerModel('room-1');
			expect(result).toBe('room-default-model');
		});

		it('should prefer agentModels.worker over room.defaultModel', () => {
			mockRoomManager.getRoom = () =>
				makeRoom({
					defaultModel: 'room-default-model',
					config: { agentModels: { worker: 'worker-specific-model' } },
				});

			const result = service.getWorkerModel('room-1');
			expect(result).toBe('worker-specific-model');
		});

		it('should allow different worker and leader models', () => {
			mockRoomManager.getRoom = () =>
				makeRoom({
					defaultModel: 'room-default',
					config: {
						agentModels: {
							leader: 'sonnet-4.6',
							worker: 'haiku-4',
						},
					},
				});

			const leaderResult = service.getLeaderModel('room-1');
			const workerResult = service.getWorkerModel('room-1');

			expect(leaderResult).toBe('sonnet-4.6');
			expect(workerResult).toBe('haiku-4');
		});
	});

	describe('setupRoomAgentSession MCP merging', () => {
		let db: Database;
		let setRuntimeMcpServersSpy: ReturnType<typeof mock>;
		let roomCreatedHandler: ((event: { room: Room }) => void) | undefined;

		// All rooms must have defaultPath set after the backfill migration.
		const mockRoom = (): Room => ({
			id: 'room-test',
			name: 'Test Room',
			allowedPaths: [{ path: '/tmp/room-test' }],
			defaultPath: '/tmp/room-test',
			defaultModel: 'claude-3',
			allowedModels: undefined,
			sessionIds: [],
			status: 'active',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		beforeEach(() => {
			// Real in-memory SQLite — no schema needed since repo constructors don't execute SQL
			db = new Database(':memory:');

			setRuntimeMcpServersSpy = mock(() => {});

			// DaemonHub mock that captures the room.created handler
			const daemonHub = {
				on: (event: string, handler: (data: unknown) => void, opts?: { sessionId?: string }) => {
					if (event === 'room.created' && opts?.sessionId === 'global') {
						roomCreatedHandler = handler as (event: { room: Room }) => void;
					}
					return () => {};
				},
			};

			// Mock AgentSession returned by sessionManager
			const mockAgentSession = {
				getSessionData: () => ({
					config: { model: 'claude-3', provider: 'anthropic' },
				}),
				setRuntimeMcpServers: setRuntimeMcpServersSpy,
				setRuntimeSystemPrompt: mock(() => {}),
			};

			// Mock SessionManager: getSessionAsync resolves immediately with mock session
			const sessionManager = {
				getSessionAsync: mock(async () => mockAgentSession),
				updateSession: mock(async () => {}),

				registerSession: () => {},
				unregisterSession: () => {},
			};

			// Mock settingsManager with project MCP servers
			const projectServers = {
				github: { command: 'npx', args: ['@github/mcp'] },
			};
			mockSettingsManager = {
				getEnabledMcpServersConfig: mock(() => projectServers),
			} as unknown as SettingsManager;

			// Mock roomManager — listRooms returns empty so initializeExistingRooms is a no-op
			mockRoomManager = {
				listRooms: () => [],
				getRoom: () => null,
			} as unknown as RoomManager;

			const config: RoomRuntimeServiceConfig = {
				db: {
					getDatabase: () => db,
					getShortIdAllocator: () => undefined,
					getSession: () => null,
				} as never,
				messageHub: { onRequest: () => {} } as never,
				daemonHub: daemonHub as never,
				getApiKey: async () => null,
				roomManager: mockRoomManager,
				sessionManager: sessionManager as never,
				defaultWorkspacePath: '/tmp',
				defaultModel: 'global-default-model',
				getGlobalSettings: () => ({}) as never,
				settingsManager: mockSettingsManager,
				reactiveDb: { onChange: () => () => {}, emit: async () => {} } as never,
			};

			service = new RoomRuntimeService(config);
		});

		afterEach(() => {
			db.close();
			roomCreatedHandler = undefined;
		});

		it('should call setRuntimeMcpServers with project servers merged with room-agent-tools', async () => {
			// Start service — subscribes to room.created, initializes no rooms
			await service.start();

			// Trigger room.created which calls createOrGetRuntime → setupRoomAgentSession
			expect(roomCreatedHandler).toBeDefined();
			roomCreatedHandler!({ room: mockRoom() });

			// Wait for the async .then() inside setupRoomAgentSession to settle
			await new Promise((r) => setTimeout(r, 0));

			expect(setRuntimeMcpServersSpy).toHaveBeenCalledTimes(1);
			const callArg = setRuntimeMcpServersSpy.mock.calls[0][0] as Record<string, unknown>;

			// Should include the project server
			expect(callArg).toHaveProperty('github');
			// Should include room-agent-tools (takes precedence, set last)
			expect(callArg).toHaveProperty('room-agent-tools');
		});

		it('should give room-agent-tools precedence over project servers with same name', async () => {
			// Override: project server also named 'room-agent-tools' — should be overridden
			(mockSettingsManager.getEnabledMcpServersConfig as ReturnType<typeof mock>).mockReturnValue({
				'room-agent-tools': { command: 'project-version', args: [] },
				'other-tool': { command: 'other-cmd' },
			});

			await service.start();
			expect(roomCreatedHandler).toBeDefined();
			roomCreatedHandler!({ room: mockRoom() });
			await new Promise((r) => setTimeout(r, 0));

			expect(setRuntimeMcpServersSpy).toHaveBeenCalledTimes(1);
			const callArg = setRuntimeMcpServersSpy.mock.calls[0][0] as Record<string, unknown>;

			// room-agent-tools should be the runtime version, not the project version
			expect(callArg['room-agent-tools']).not.toEqual({
				command: 'project-version',
				args: [],
			});
			// other-tool should still be present
			expect(callArg).toHaveProperty('other-tool');
		});

		it('should call setRuntimeMcpServers with only room-agent-tools when no project servers', async () => {
			(mockSettingsManager.getEnabledMcpServersConfig as ReturnType<typeof mock>).mockReturnValue(
				{}
			);

			await service.start();
			expect(roomCreatedHandler).toBeDefined();
			roomCreatedHandler!({ room: mockRoom() });
			await new Promise((r) => setTimeout(r, 0));

			expect(setRuntimeMcpServersSpy).toHaveBeenCalledTimes(1);
			const callArg = setRuntimeMcpServersSpy.mock.calls[0][0] as Record<string, unknown>;

			expect(Object.keys(callArg)).toEqual(['room-agent-tools']);
		});
	});
});

describe('RoomRuntimeService restart recovery', () => {
	let rawDb: Database;

	afterEach(() => {
		rawDb?.close();
	});

	function makeDaemonHub() {
		const listeners = new Map<string, Array<(data: unknown) => void>>();
		return {
			on(event: string, handler: (data: unknown) => void, options?: { sessionId?: string }) {
				const key = `${event}:${options?.sessionId ?? '*'}`;
				const current = listeners.get(key) ?? [];
				current.push(handler);
				listeners.set(key, current);
				return () => {
					const next = (listeners.get(key) ?? []).filter((fn) => fn !== handler);
					if (next.length === 0) listeners.delete(key);
					else listeners.set(key, next);
				};
			},
			emit(event: string, data: Record<string, unknown> & { sessionId?: string }) {
				for (const key of [`${event}:*`, `${event}:${data.sessionId ?? '*'}`]) {
					for (const handler of listeners.get(key) ?? []) {
						handler(data);
					}
				}
			},
		};
	}

	function createMockSessionFactory() {
		return {
			async createAndStartSession() {},
			async injectMessage() {},
			hasSession() {
				return true;
			},
			async answerQuestion() {
				return false;
			},
			async createWorktree() {
				return null;
			},
			async restoreSession() {
				return true;
			},
			async startSession() {
				return true;
			},
			setSessionMcpServers() {
				return true;
			},
			async removeWorktree() {
				return false;
			},
			async switchModel(_sessionId: string, model: string, _provider: string) {
				return { success: true, model };
			},
			async getCurrentModel(_sessionId: string) {
				return { currentModel: 'sonnet', provider: 'anthropic' };
			},
		} satisfies SessionFactory;
	}

	it('reattaches group mirroring during startup resume without writing projection rows', async () => {
		rawDb = new Database(':memory:');
		rawDb.exec(`
			CREATE TABLE rooms (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE goals (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'active',
				priority TEXT NOT NULL DEFAULT 'normal',
				progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]',
				metrics TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				planning_attempts INTEGER DEFAULT 0,
				goal_review_attempts INTEGER DEFAULT 0,
				mission_type TEXT NOT NULL DEFAULT 'one_shot',
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				schedule TEXT,
				schedule_paused INTEGER NOT NULL DEFAULT 0,
				next_run_at INTEGER,
				structured_metrics TEXT,
				max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
				max_planning_attempts INTEGER NOT NULL DEFAULT 5,
				consecutive_failures INTEGER NOT NULL DEFAULT 0,
				replan_count INTEGER NOT NULL DEFAULT 0,
				short_id TEXT
			);
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				priority TEXT NOT NULL DEFAULT 'normal',
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				task_type TEXT DEFAULT 'coding',
				created_by_task_id TEXT,
				assigned_agent TEXT DEFAULT 'coder',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				archived_at INTEGER,
				active_session TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				short_id TEXT,
				updated_at INTEGER
			);
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_worker',
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, session_id)
			);
			CREATE TABLE task_group_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				payload_json TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE session_group_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT,
				role TEXT NOT NULL DEFAULT 'system',
				message_type TEXT NOT NULL DEFAULT 'status',
				content TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL
			);
		`);

		const now = Date.now();
		rawDb
			.prepare(`INSERT INTO rooms (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
			.run('room-1', 'Test Room', now, now);
		rawDb
			.prepare(
				`INSERT INTO tasks (id, room_id, title, description, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run('task-1', 'room-1', 'Recovered task', 'Desc', 'in_progress', now);

		const daemonHub = makeDaemonHub();
		const groupRepo = new SessionGroupRepository(rawDb, noOpReactiveDb);
		const taskManager = new TaskManager(rawDb as never, 'room-1', noOpReactiveDb);
		const goalManager = new GoalManager(rawDb as never, 'room-1', noOpReactiveDb);
		const observer = new SessionObserver(daemonHub as never);
		const sessionFactory = createMockSessionFactory();
		const group = groupRepo.createGroup('task-1', 'worker:task-1', 'leader:task-1');

		const runtime = new RoomRuntime({
			room: {
				id: 'room-1',
				name: 'Test Room',
				allowedPaths: [{ path: '/workspace', label: 'ws' }],
				defaultPath: '/workspace',
				sessionIds: [],
				status: 'active',
				createdAt: now,
				updatedAt: now,
			},
			groupRepo,
			sessionObserver: observer,
			taskManager,
			goalManager,
			sessionFactory,
			workspacePath: '/workspace',
			daemonHub: daemonHub as never,
		});

		const config: RoomRuntimeServiceConfig = {
			db: {
				getDatabase: () => rawDb,
				getShortIdAllocator: () => undefined,
				getSession: (sessionId: string) =>
					sessionId === 'worker:task-1' || sessionId === 'leader:task-1'
						? ({ id: sessionId } as never)
						: null,
			} as never,
			messageHub: {} as never,
			daemonHub: daemonHub as never,
			getApiKey: async () => null,
			roomManager: {
				getRoom: () => null,
			} as unknown as RoomManager,
			sessionManager: { registerSession: () => {}, unregisterSession: () => {} } as never,
			defaultWorkspacePath: '/workspace',
			defaultModel: 'test-model',
			getGlobalSettings: () => ({}) as never,
			reactiveDb: noOpReactiveDb,
		};

		const service = new RoomRuntimeService(config);
		const serviceAny = service as unknown as {
			createSessionFactory: () => SessionFactory;
			recoverRoomRuntime: (
				roomId: string,
				runtime: RoomRuntime,
				observer: SessionObserver
			) => Promise<void>;
		};
		serviceAny.createSessionFactory = () => sessionFactory;

		await serviceAny.recoverRoomRuntime('room-1', runtime, observer);

		daemonHub.emit('sdk.message', {
			sessionId: 'worker:task-1',
			message: {
				uuid: 'msg-1',
				type: 'assistant',
				text: 'Recovered worker output',
			},
		});

		const mirrored = rawDb
			.prepare(`SELECT COUNT(*) AS count FROM session_group_messages WHERE group_id = ?`)
			.get(group.id) as { count: number };
		expect(mirrored.count).toBe(0);

		runtime.stop();
	});
});

describe('createOrGetRuntime — defaultPath guard', () => {
	it('throws when room.defaultPath is undefined', () => {
		const config: RoomRuntimeServiceConfig = {
			db: {} as never,
			messageHub: {} as never,
			daemonHub: { on: () => () => {} } as never,
			getApiKey: async () => null,
			roomManager: { listRooms: () => [], getRoom: () => null } as never,
			sessionManager: { registerSession: () => {}, unregisterSession: () => {} } as never,
			defaultModel: 'test-model',
			getGlobalSettings: () => ({}) as never,
			settingsManager: { getEnabledMcpServersConfig: () => ({}) } as never,
			reactiveDb: {} as never,
		};

		const service = new RoomRuntimeService(config);
		const serviceAny = service as unknown as {
			createOrGetRuntime: (room: Room) => RoomRuntime;
		};

		const roomWithoutPath: Room = {
			id: 'room-no-path',
			name: 'No Path Room',
			allowedPaths: [],
			defaultPath: undefined,
			sessionIds: [],
			status: 'active',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		// Guard fires before any DB access, so db: {} (no getDatabase) is fine here
		expect(() => serviceAny.createOrGetRuntime(roomWithoutPath)).toThrow('missing defaultPath');
	});

	it('succeeds and returns a RoomRuntime when room.defaultPath is set (no defaultWorkspacePath needed)', async () => {
		// This test verifies that:
		// 1. A room with defaultPath creates a runtime without throwing.
		// 2. defaultWorkspacePath is NOT required in RoomRuntimeServiceConfig —
		//    rooms are fully self-contained with their own defaultPath.
		const { Database: BunDatabase } = await import('bun:sqlite');
		const rawDb = new BunDatabase(':memory:');

		rawDb.exec(`
			CREATE TABLE goals (id TEXT PRIMARY KEY, room_id TEXT, title TEXT, description TEXT DEFAULT '',
				status TEXT DEFAULT 'active', priority TEXT DEFAULT 'normal', progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]', metrics TEXT DEFAULT '{}',
				created_at INTEGER, updated_at INTEGER, completed_at INTEGER,
				planning_attempts INTEGER DEFAULT 0, goal_review_attempts INTEGER DEFAULT 0,
				mission_type TEXT DEFAULT 'one_shot', autonomy_level TEXT DEFAULT 'supervised',
				schedule TEXT, schedule_paused INTEGER DEFAULT 0, next_run_at INTEGER,
				structured_metrics TEXT, max_consecutive_failures INTEGER DEFAULT 3,
				max_planning_attempts INTEGER DEFAULT 5, consecutive_failures INTEGER DEFAULT 0,
				replan_count INTEGER DEFAULT 0, short_id TEXT);
			CREATE TABLE tasks (id TEXT PRIMARY KEY, room_id TEXT, title TEXT, description TEXT,
				status TEXT DEFAULT 'pending', priority TEXT DEFAULT 'normal', progress INTEGER,
				current_step TEXT, result TEXT, error TEXT, depends_on TEXT DEFAULT '[]',
				task_type TEXT DEFAULT 'coding', created_by_task_id TEXT, assigned_agent TEXT DEFAULT 'coder',
				created_at INTEGER, started_at INTEGER, completed_at INTEGER, archived_at INTEGER,
				active_session TEXT, pr_url TEXT, pr_number INTEGER, pr_created_at INTEGER,
				short_id TEXT, updated_at INTEGER);
			CREATE TABLE session_groups (id TEXT PRIMARY KEY, group_type TEXT DEFAULT 'task',
				ref_id TEXT, state TEXT DEFAULT 'awaiting_worker', version INTEGER DEFAULT 0,
				metadata TEXT DEFAULT '{}', created_at INTEGER, completed_at INTEGER);
			CREATE TABLE session_group_members (group_id TEXT, session_id TEXT, role TEXT, joined_at INTEGER,
				PRIMARY KEY (group_id, session_id));
			CREATE TABLE task_group_events (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT,
				kind TEXT, payload_json TEXT, created_at INTEGER);
			CREATE TABLE session_group_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT,
				session_id TEXT, role TEXT DEFAULT 'system', message_type TEXT DEFAULT 'status',
				content TEXT DEFAULT '', created_at INTEGER);
		`);

		const config: RoomRuntimeServiceConfig = {
			db: {
				getDatabase: () => rawDb,
				getShortIdAllocator: () => undefined,
				getSession: () => null,
			} as never,
			messageHub: {} as never,
			daemonHub: { on: () => () => {} } as never,
			getApiKey: async () => null,
			roomManager: { listRooms: () => [], getRoom: () => null } as never,
			sessionManager: {
				getSessionAsync: async () => null,
				registerSession: () => {},
				unregisterSession: () => {},
			} as never,
			// defaultWorkspacePath intentionally omitted — it is now optional.
			// createOrGetRuntime must work without it when room.defaultPath is set.
			defaultModel: 'test-model',
			getGlobalSettings: () => ({}) as never,
			settingsManager: { getEnabledMcpServersConfig: () => ({}) } as never,
			reactiveDb: { onChange: () => () => {}, emit: async () => {} } as never,
		};

		const service = new RoomRuntimeService(config);
		const serviceAny = service as unknown as {
			createOrGetRuntime: (room: Room, autoStart?: boolean) => RoomRuntime;
		};

		const room: Room = {
			id: 'room-custom',
			name: 'Custom Path Room',
			allowedPaths: [{ path: '/custom/workspace' }],
			defaultPath: '/custom/workspace',
			sessionIds: [],
			status: 'active',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		// Should not throw — room has defaultPath set and defaultWorkspacePath is absent
		const runtime = serviceAny.createOrGetRuntime(room, false /* don't autoStart */);
		expect(runtime).toBeDefined();
		// Verify the returned value is a RoomRuntime instance
		const { RoomRuntime: RoomRuntimeClass } = await import(
			'../../../src/lib/room/runtime/room-runtime'
		);
		expect(runtime).toBeInstanceOf(RoomRuntimeClass);

		rawDb.close();
	});
});

describe('SessionFactory.getCurrentModel', () => {
	it('returns model/provider from DB and null for missing sessions', async () => {
		const getSession = mock(() => null);
		const config: RoomRuntimeServiceConfig = {
			db: { getSession } as never,
			messageHub: {} as never,
			daemonHub: {} as never,
			getApiKey: async () => null,
			roomManager: { getRoom: () => null } as never,
			sessionManager: { registerSession: () => {}, unregisterSession: () => {} } as never,
			defaultWorkspacePath: '/tmp',
			defaultModel: 'default',
			getGlobalSettings: () => ({}) as never,
			settingsManager: { getEnabledMcpServersConfig: () => ({}) } as never,
			reactiveDb: {} as never,
		};

		const service = new RoomRuntimeService(config);
		const serviceAny = service as unknown as {
			createSessionFactory: () => ReturnType<
				typeof import('../../../src/lib/room/runtime/room-runtime-service').RoomRuntimeService.prototype.createSessionFactory
			>;
		};
		const factory = serviceAny.createSessionFactory();

		// Missing session → null
		expect(await factory.getCurrentModel('non-existent')).toBeNull();
		expect(getSession).toHaveBeenCalledWith('non-existent');

		// Session with model and provider
		getSession.mockReturnValueOnce({
			config: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
		} as never);
		const result = await factory.getCurrentModel('session-1');
		expect(result).toEqual({
			currentModel: 'claude-sonnet-4-20250514',
			provider: 'anthropic',
		});

		// Session with model but no provider → defaults to 'anthropic'
		getSession.mockReturnValueOnce({
			config: { model: 'glm-5-turbo' },
		} as never);
		const result2 = await factory.getCurrentModel('session-2');
		expect(result2).toEqual({
			currentModel: 'glm-5-turbo',
			provider: 'anthropic',
		});

		// Reads from DB, not in-memory cache: cache is empty but DB returns data
		getSession.mockReturnValueOnce({
			config: { model: 'cached-model', provider: 'glm' },
		} as never);
		const result3 = await factory.getCurrentModel('session-not-in-cache');
		expect(result3).toEqual({
			currentModel: 'cached-model',
			provider: 'glm',
		});
	});
});

describe('SessionFactory.restoreSession — worker MCP injection and skills', () => {
	type FactoryType = ReturnType<
		typeof import('../../../src/lib/room/runtime/room-runtime-service').RoomRuntimeService.prototype.createSessionFactory
	>;

	function makeConfig(overrides: {
		fileMcpServers?: Record<string, unknown>;
		registryMcpServers?: Record<string, unknown>;
		skillsManager?: unknown;
		appMcpServerRepo?: unknown;
	}): RoomRuntimeServiceConfig {
		return {
			db: { getSession: mock(() => null) } as never,
			messageHub: {} as never,
			daemonHub: {} as never,
			getApiKey: async () => null,
			roomManager: { getRoom: () => null } as never,
			sessionManager: { registerSession: () => {}, unregisterSession: () => {} } as never,
			defaultWorkspacePath: '/tmp',
			defaultModel: 'default',
			getGlobalSettings: () => ({}) as never,
			settingsManager: {
				getEnabledMcpServersConfig: mock(() => overrides.fileMcpServers ?? {}),
			} as never,
			appMcpManager: overrides.registryMcpServers
				? { getEnabledMcpConfigs: mock(() => overrides.registryMcpServers) }
				: undefined,
			skillsManager: overrides.skillsManager as never,
			appMcpServerRepo: overrides.appMcpServerRepo as never,
			reactiveDb: {} as never,
		};
	}

	function makeMockSession() {
		const setRuntimeMcpServersSpy = mock((_servers: unknown) => {});
		return {
			session: {
				contextAutoQueueEnabled: true,
				setRuntimeMcpServers: setRuntimeMcpServersSpy,
			} as unknown as AgentSession,
			setRuntimeMcpServersSpy,
		};
	}

	it('passes skillsManager and appMcpServerRepo to AgentSession.restore()', async () => {
		const mockSkillsManager = { name: 'skillsManager' };
		const mockAppMcpServerRepo = { name: 'appMcpServerRepo' };
		const { session } = makeMockSession();
		const restoreSpy = spyOn(AgentSession, 'restore').mockReturnValue(session);

		try {
			const config = makeConfig({
				skillsManager: mockSkillsManager,
				appMcpServerRepo: mockAppMcpServerRepo,
			});
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as { createSessionFactory: () => FactoryType }
			).createSessionFactory();

			await factory.restoreSession('coder:room-1:task-1:abc12345');

			expect(restoreSpy).toHaveBeenCalledTimes(1);
			const callArgs = restoreSpy.mock.calls[0];
			expect(callArgs[5]).toBe(mockSkillsManager);
			expect(callArgs[6]).toBe(mockAppMcpServerRepo);
		} finally {
			restoreSpy.mockRestore();
		}
	});

	it('applies file + registry MCP merge for a restored coder session', async () => {
		const { session, setRuntimeMcpServersSpy } = makeMockSession();
		const restoreSpy = spyOn(AgentSession, 'restore').mockReturnValue(session);

		try {
			const config = makeConfig({
				fileMcpServers: { 'file-server': { command: 'npx', args: ['file-mcp'] } },
				registryMcpServers: { 'registry-server': { command: 'npx', args: ['registry-mcp'] } },
			});
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as { createSessionFactory: () => FactoryType }
			).createSessionFactory();

			await factory.restoreSession('coder:room-1:task-1:abc12345');

			expect(setRuntimeMcpServersSpy).toHaveBeenCalledTimes(1);
			const merged = setRuntimeMcpServersSpy.mock.calls[0][0] as Record<string, unknown>;
			expect(merged).toHaveProperty('file-server');
			expect(merged).toHaveProperty('registry-server');
		} finally {
			restoreSpy.mockRestore();
		}
	});

	it('applies file + registry MCP merge for a restored general session', async () => {
		const { session, setRuntimeMcpServersSpy } = makeMockSession();
		const restoreSpy = spyOn(AgentSession, 'restore').mockReturnValue(session);

		try {
			const config = makeConfig({
				fileMcpServers: { 'file-server': { command: 'npx', args: ['file-mcp'] } },
			});
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as { createSessionFactory: () => FactoryType }
			).createSessionFactory();

			await factory.restoreSession('general:room-1:task-1:abc12345');

			expect(setRuntimeMcpServersSpy).toHaveBeenCalledTimes(1);
			const merged = setRuntimeMcpServersSpy.mock.calls[0][0] as Record<string, unknown>;
			expect(merged).toHaveProperty('file-server');
		} finally {
			restoreSpy.mockRestore();
		}
	});

	it('file-based MCP servers take precedence over registry on name collision', async () => {
		const { session, setRuntimeMcpServersSpy } = makeMockSession();
		const restoreSpy = spyOn(AgentSession, 'restore').mockReturnValue(session);

		try {
			const config = makeConfig({
				fileMcpServers: { 'shared-name': { command: 'file-cmd', args: [] } },
				registryMcpServers: { 'shared-name': { command: 'registry-cmd', args: [] } },
			});
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as { createSessionFactory: () => FactoryType }
			).createSessionFactory();

			await factory.restoreSession('coder:room-1:task-1:abc12345');

			const merged = setRuntimeMcpServersSpy.mock.calls[0][0] as Record<
				string,
				{ command: string }
			>;
			expect(merged['shared-name'].command).toBe('file-cmd');
		} finally {
			restoreSpy.mockRestore();
		}
	});

	it('does NOT apply worker MCP merge for a restored planner session', async () => {
		const { session, setRuntimeMcpServersSpy } = makeMockSession();
		const restoreSpy = spyOn(AgentSession, 'restore').mockReturnValue(session);

		try {
			const config = makeConfig({
				fileMcpServers: { 'file-server': { command: 'npx', args: ['file-mcp'] } },
			});
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as { createSessionFactory: () => FactoryType }
			).createSessionFactory();

			await factory.restoreSession('planner:room-1:task-1:abc12345');

			expect(setRuntimeMcpServersSpy).not.toHaveBeenCalled();
		} finally {
			restoreSpy.mockRestore();
		}
	});

	it('does NOT apply worker MCP merge for a restored leader session', async () => {
		const { session, setRuntimeMcpServersSpy } = makeMockSession();
		const restoreSpy = spyOn(AgentSession, 'restore').mockReturnValue(session);

		try {
			const config = makeConfig({
				fileMcpServers: { 'file-server': { command: 'npx', args: ['file-mcp'] } },
			});
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as { createSessionFactory: () => FactoryType }
			).createSessionFactory();

			await factory.restoreSession('leader:room-1:task-1:abc12345');

			expect(setRuntimeMcpServersSpy).not.toHaveBeenCalled();
		} finally {
			restoreSpy.mockRestore();
		}
	});

	it('does not call setRuntimeMcpServers when no MCP servers are configured', async () => {
		const { session, setRuntimeMcpServersSpy } = makeMockSession();
		const restoreSpy = spyOn(AgentSession, 'restore').mockReturnValue(session);

		try {
			const config = makeConfig({
				fileMcpServers: {},
				registryMcpServers: {},
			});
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as { createSessionFactory: () => FactoryType }
			).createSessionFactory();

			await factory.restoreSession('coder:room-1:task-1:abc12345');

			expect(setRuntimeMcpServersSpy).not.toHaveBeenCalled();
		} finally {
			restoreSpy.mockRestore();
		}
	});

	it('returns false and does not inject MCPs when AgentSession.restore returns null', async () => {
		const restoreSpy = spyOn(AgentSession, 'restore').mockReturnValue(null);

		try {
			const config = makeConfig({
				fileMcpServers: { 'file-server': { command: 'npx', args: [] } },
			});
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as { createSessionFactory: () => FactoryType }
			).createSessionFactory();

			const result = await factory.restoreSession('coder:room-1:task-1:abc12345');

			expect(result).toBe(false);
		} finally {
			restoreSpy.mockRestore();
		}
	});
});
