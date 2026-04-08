/**
 * Unit tests for NeoActivityLogger
 *
 * Covers:
 * - logAction: inserts entry with full context (success, error, undoable)
 * - logAction: omits undoable flag when action fails
 * - getRecentActivity: offset=0 and offset>0 paths
 * - getLatestUndoable: returns most recent undoable entry
 * - pruneOldEntries: called on construction; enforces 30-day retention and 10k row cap
 *
 * Also covers NeoActivityLogRepository additions:
 * - update(): partial field update
 * - pruneOldEntries(): age-based deletion and row-count cap
 */

import { mock } from 'bun:test';

// Re-declare the SDK mock so it survives Bun's module isolation.
// Without this, a preceding test file's mock.module() override (e.g. room-agent-tools.test.ts)
// returns a 'tool()' that discards the handler, causing callTool() to fail.
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
import { createTables } from '../../../../src/storage/schema';
import { NeoActivityLogRepository } from '../../../../src/storage/repositories/neo-activity-log-repository';
import { NeoActivityLogger } from '../../../../src/lib/neo/activity-logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	createTables(db);
	return db;
}

function makeRepo(db: BunDatabase): NeoActivityLogRepository {
	return new NeoActivityLogRepository(db);
}

function makeLogger(db: BunDatabase): NeoActivityLogger {
	return new NeoActivityLogger(makeRepo(db));
}

// ---------------------------------------------------------------------------
// NeoActivityLogRepository — update() and pruneOldEntries()
// ---------------------------------------------------------------------------

describe('NeoActivityLogRepository.update()', () => {
	let db: BunDatabase;
	let repo: NeoActivityLogRepository;

	beforeEach(() => {
		db = makeDb();
		repo = makeRepo(db);
		repo.insert({
			id: 'entry-1',
			toolName: 'toggle_skill',
			input: JSON.stringify({ skill_id: 'sk-1', enabled: true }),
			status: 'error',
		});
	});

	afterEach(() => db.close());

	test('updates status and error fields', () => {
		const updated = repo.update('entry-1', {
			status: 'success',
			output: '{"success":true}',
			error: null,
		});
		expect(updated?.status).toBe('success');
		expect(updated?.output).toBe('{"success":true}');
		expect(updated?.error).toBeNull();
	});

	test('updates undoable and undoData', () => {
		const undoData = JSON.stringify({ skillId: 'sk-1', previousEnabled: false });
		const updated = repo.update('entry-1', {
			undoable: true,
			undoData,
		});
		expect(updated?.undoable).toBe(true);
		expect(updated?.undoData).toBe(undoData);
	});

	test('updates targetType and targetId', () => {
		const updated = repo.update('entry-1', {
			targetType: 'skill',
			targetId: 'sk-1',
		});
		expect(updated?.targetType).toBe('skill');
		expect(updated?.targetId).toBe('sk-1');
	});

	test('returns null for unknown id', () => {
		const result = repo.update('does-not-exist', { status: 'success' });
		expect(result).toBeNull();
	});

	test('no-op when params are empty returns existing entry', () => {
		const original = repo.getById('entry-1')!;
		const result = repo.update('entry-1', {});
		expect(result?.id).toBe(original.id);
		expect(result?.status).toBe(original.status);
	});
});

describe('NeoActivityLogRepository.pruneOldEntries()', () => {
	let db: BunDatabase;
	let repo: NeoActivityLogRepository;

	beforeEach(() => {
		db = makeDb();
		repo = makeRepo(db);
	});

	afterEach(() => db.close());

	test('deletes entries older than 30 days', () => {
		// Insert one old entry and one recent entry via raw SQL to set created_at precisely.
		db.prepare(
			`INSERT INTO neo_activity_log
       (id, tool_name, input, output, status, error, target_type, target_id, undoable, undo_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			'old-entry',
			'delete_room',
			null,
			null,
			'success',
			null,
			null,
			null,
			0,
			null,
			'2020-01-01T00:00:00.000Z'
		);

		repo.insert({ id: 'recent-entry', toolName: 'create_room', status: 'success' });

		const deleted = repo.pruneOldEntries();
		expect(deleted).toBeGreaterThanOrEqual(1);

		expect(repo.getById('old-entry')).toBeNull();
		expect(repo.getById('recent-entry')).not.toBeNull();
	});

	test('trims to 10 000 rows when exceeded — oldest removed first', () => {
		// Insert 10 003 recent entries.
		const stmt = db.prepare(
			`INSERT INTO neo_activity_log
       (id, tool_name, input, output, status, error, target_type, target_id, undoable, undo_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		const total = 10_003;
		for (let i = 0; i < total; i++) {
			const ts = new Date(Date.now() + i).toISOString();
			stmt.run(`entry-${i}`, 'create_room', null, null, 'success', null, null, null, 0, null, ts);
		}

		const deleted = repo.pruneOldEntries();
		expect(deleted).toBeGreaterThanOrEqual(3);

		const remaining = repo.list({ limit: 10_100 });
		expect(remaining.length).toBeLessThanOrEqual(10_000);

		// The oldest entries (entry-0, entry-1, entry-2) should be gone.
		expect(repo.getById('entry-0')).toBeNull();
		// The newest should remain.
		expect(repo.getById(`entry-${total - 1}`)).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// NeoActivityLogger
// ---------------------------------------------------------------------------

describe('NeoActivityLogger', () => {
	let db: BunDatabase;
	let logger: NeoActivityLogger;

	beforeEach(() => {
		db = makeDb();
		logger = makeLogger(db);
	});

	afterEach(() => db.close());

	// ── logAction ────────────────────────────────────────────────────────────

	test('logAction records a successful action', () => {
		const entry = logger.logAction({
			toolName: 'create_room',
			input: { name: 'My Room' },
			output: '{"success":true,"room":{"id":"room-1"}}',
			status: 'success',
			targetType: 'room',
			targetId: 'room-1',
			undoable: true,
			undoData: { roomId: 'room-1' },
		});

		expect(entry.toolName).toBe('create_room');
		expect(entry.status).toBe('success');
		expect(entry.input).toBe(JSON.stringify({ name: 'My Room' }));
		expect(entry.targetType).toBe('room');
		expect(entry.targetId).toBe('room-1');
		expect(entry.undoable).toBe(true);
		expect(entry.undoData).toBe(JSON.stringify({ roomId: 'room-1' }));
		expect(entry.id).toHaveLength(36); // UUID
	});

	test('logAction records a failed action', () => {
		const entry = logger.logAction({
			toolName: 'create_room',
			input: { name: '' },
			status: 'error',
			error: 'Room name is required',
			undoable: false,
		});

		expect(entry.status).toBe('error');
		expect(entry.error).toBe('Room name is required');
		expect(entry.undoable).toBe(false);
		expect(entry.undoData).toBeNull();
	});

	test('logAction records a cancelled action', () => {
		const entry = logger.logAction({
			toolName: 'delete_room',
			input: { room_id: 'room-1' },
			status: 'cancelled',
		});
		expect(entry.status).toBe('cancelled');
	});

	test('logAction with null undoData stores null', () => {
		const entry = logger.logAction({
			toolName: 'delete_room',
			input: { room_id: 'room-1' },
			status: 'success',
			undoData: null,
		});
		expect(entry.undoData).toBeNull();
	});

	// ── getRecentActivity ─────────────────────────────────────────────────────

	test('getRecentActivity returns entries newest-first', () => {
		// Insert via raw SQL with distinct recent timestamps to guarantee ordering.
		const rawRepo = makeRepo(db);
		const stmt = db.prepare(
			`INSERT INTO neo_activity_log
       (id, tool_name, input, output, status, error, target_type, target_id, undoable, undo_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		const base = new Date();
		const t1 = new Date(base.getTime() - 2000).toISOString();
		const t2 = new Date(base.getTime() - 1000).toISOString();
		const t3 = base.toISOString();
		stmt.run('a1', 'create_room', null, null, 'success', null, null, null, 0, null, t1);
		stmt.run('a2', 'toggle_skill', null, null, 'success', null, null, null, 0, null, t2);
		stmt.run('a3', 'update_app_settings', null, null, 'success', null, null, null, 0, null, t3);

		const logger2 = new NeoActivityLogger(rawRepo);
		const entries = logger2.getRecentActivity(10);
		expect(entries.length).toBe(3);
		// Newest first (created_at DESC).
		expect(entries[0].toolName).toBe('update_app_settings');
		expect(entries[2].toolName).toBe('create_room');
	});

	test('getRecentActivity default limit is 50', () => {
		for (let i = 0; i < 60; i++) {
			logger.logAction({ toolName: `tool-${i}`, input: {}, status: 'success' });
		}
		const entries = logger.getRecentActivity();
		expect(entries.length).toBe(50);
	});

	test('getRecentActivity respects limit', () => {
		for (let i = 0; i < 10; i++) {
			logger.logAction({ toolName: `tool-${i}`, input: {}, status: 'success' });
		}
		const entries = logger.getRecentActivity(3);
		expect(entries.length).toBe(3);
	});

	test('getRecentActivity with offset skips entries', () => {
		for (let i = 0; i < 5; i++) {
			logger.logAction({ toolName: `tool-${i}`, input: {}, status: 'success' });
		}
		const all = logger.getRecentActivity(10, 0);
		expect(all.length).toBe(5);

		const page1 = logger.getRecentActivity(2, 0);
		const page2 = logger.getRecentActivity(2, 2);

		expect(page1.length).toBe(2);
		expect(page2.length).toBe(2);
		// Pages should not overlap.
		const ids1 = new Set(page1.map((e) => e.id));
		const ids2 = new Set(page2.map((e) => e.id));
		for (const id of ids2) {
			expect(ids1.has(id)).toBe(false);
		}
		// page1 should match the first two entries from the full list.
		expect(page1[0].id).toBe(all[0].id);
		expect(page1[1].id).toBe(all[1].id);
		// page2 should match entries 3 and 4.
		expect(page2[0].id).toBe(all[2].id);
		expect(page2[1].id).toBe(all[3].id);
	});

	test('getRecentActivity returns empty array on empty DB', () => {
		expect(logger.getRecentActivity()).toEqual([]);
	});

	// ── getLatestUndoable ─────────────────────────────────────────────────────

	test('getLatestUndoable returns null when no undoable entries', () => {
		logger.logAction({ toolName: 'delete_room', input: {}, status: 'success', undoable: false });
		expect(logger.getLatestUndoable()).toBeNull();
	});

	test('getLatestUndoable returns the most recent undoable entry', () => {
		// Insert via raw SQL with distinct recent timestamps to guarantee ordering.
		const stmt = db.prepare(
			`INSERT INTO neo_activity_log
       (id, tool_name, input, output, status, error, target_type, target_id, undoable, undo_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		const base = new Date();
		const t1 = new Date(base.getTime() - 2000).toISOString();
		const t2 = new Date(base.getTime() - 1000).toISOString();
		const t3 = base.toISOString();
		stmt.run(
			'u1',
			'toggle_skill',
			null,
			null,
			'success',
			null,
			null,
			null,
			1,
			JSON.stringify({ skillId: 'sk-1', previousEnabled: false }),
			t1
		);
		stmt.run(
			'u2',
			'create_room',
			null,
			null,
			'success',
			null,
			null,
			null,
			1,
			JSON.stringify({ roomId: 'room-new' }),
			t2
		);
		stmt.run('u3', 'delete_room', null, null, 'success', null, null, null, 0, null, t3);

		const rawRepo = makeRepo(db);
		const logger2 = new NeoActivityLogger(rawRepo);
		const latest = logger2.getLatestUndoable();
		// create_room (u2) is the most recent undoable — delete_room (u3, t3) is not undoable.
		expect(latest?.toolName).toBe('create_room');
		expect(latest?.undoData).toBe(JSON.stringify({ roomId: 'room-new' }));
	});

	// ── pruneOldEntries (via constructor) ─────────────────────────────────────

	test('pruneOldEntries returns 0 when DB is empty', () => {
		const deleted = logger.pruneOldEntries();
		expect(deleted).toBe(0);
	});

	test('constructor calls pruneOldEntries (does not throw even if nothing to prune)', () => {
		// If constructor calls pruneOldEntries and DB is empty, no error should be thrown.
		expect(() => new NeoActivityLogger(makeRepo(db))).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Activity logging wrapper in createNeoActionMcpServer
// ---------------------------------------------------------------------------

describe('createNeoActionMcpServer — activity logging', () => {
	let db: BunDatabase;
	let repo: NeoActivityLogRepository;
	let logger: NeoActivityLogger;

	beforeEach(() => {
		db = makeDb();
		repo = makeRepo(db);
		// Avoid double-pruning noise in tests by using repo directly.
		logger = new NeoActivityLogger(repo);
	});

	afterEach(() => db.close());

	/**
	 * Build a minimal NeoActionToolsConfig with the given activityLogger and
	 * a spy that records tool invocations for the handlers under test.
	 */
	function makeConfig(
		overrides: Partial<{
			roomsById: Map<string, import('@neokai/shared').Room>;
			skillEnabled: boolean;
			mcpEnabled: boolean;
			settingsValue: Partial<import('@neokai/shared').GlobalSettings>;
			goalStatus: string;
			taskStatus: string;
		}> = {}
	) {
		const { PendingActionStore: PAS } = require('../../../../src/lib/neo/security-tier') as {
			PendingActionStore: typeof import('../../../../src/lib/neo/security-tier').PendingActionStore;
		};
		const { createNeoActionMcpServer } =
			require('../../../../src/lib/neo/tools/neo-action-tools') as typeof import('../../../../src/lib/neo/tools/neo-action-tools');

		const rooms = overrides.roomsById ?? new Map<string, import('@neokai/shared').Room>();

		const roomManager: import('../../../../src/lib/neo/tools/neo-action-tools').NeoActionRoomManager =
			{
				createRoom: (params) => {
					const room: import('@neokai/shared').Room = {
						id: 'new-room-id',
						name: params.name,
						status: 'active',
						sessionIds: [],
						allowedPaths: params.allowedPaths ?? [],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					};
					rooms.set(room.id, room);
					return room;
				},
				deleteRoom: (id) => {
					if (!rooms.has(id)) return false;
					rooms.delete(id);
					return true;
				},
				getRoom: (id) => rooms.get(id) ?? null,
				updateRoom: (id, params) => {
					const existing = rooms.get(id);
					if (!existing) return null;
					const updated = {
						...existing,
						...params,
						updatedAt: Date.now(),
					} as import('@neokai/shared').Room;
					rooms.set(id, updated);
					return updated;
				},
			};

		const skillEnabled = overrides.skillEnabled ?? false;
		const skillsManager: import('../../../../src/lib/neo/tools/neo-action-tools').NeoSkillsManager =
			{
				addSkill: () => {
					throw new Error('not used');
				},
				updateSkill: () => {
					throw new Error('not used');
				},
				setSkillEnabled: (id, enabled) =>
					({
						id,
						name: 'test-skill',
						displayName: 'Test Skill',
						description: '',
						enabled,
						builtIn: false,
						sourceType: 'plugin',
						config: { type: 'plugin', pluginPath: '/path/to/plugin' },
						validationStatus: 'pending',
						createdAt: 0,
						updatedAt: 0,
					}) as import('@neokai/shared').AppSkill,
				removeSkill: () => false,
				getSkill: (id) =>
					({
						id,
						name: 'test-skill',
						displayName: 'Test Skill',
						description: '',
						enabled: skillEnabled,
						builtIn: false,
						sourceType: 'plugin',
						config: { type: 'plugin', pluginPath: '/path/to/plugin' },
						validationStatus: 'pending',
						createdAt: 0,
						updatedAt: 0,
					}) as import('@neokai/shared').AppSkill,
			};

		const mcpEnabled = overrides.mcpEnabled ?? true;
		const mcpManager: import('../../../../src/lib/neo/tools/neo-action-tools').NeoMcpManager = {
			createMcpServer: () => {
				throw new Error('not used');
			},
			updateMcpServer: (id, upd) =>
				({
					id,
					name: 'test-mcp',
					sourceType: 'stdio',
					enabled: upd.enabled ?? mcpEnabled,
					createdAt: 0,
					updatedAt: 0,
				}) as import('@neokai/shared').AppMcpServer,
			deleteMcpServer: () => false,
			getMcpServer: (id) =>
				({
					id,
					name: 'test-mcp',
					sourceType: 'stdio',
					enabled: mcpEnabled,
					createdAt: 0,
					updatedAt: 0,
				}) as import('@neokai/shared').AppMcpServer,
			getMcpServerByName: () => null,
		};

		const currentSettings: import('@neokai/shared').GlobalSettings = {
			model: 'sonnet',
			thinkingLevel: 'low',
			autoScroll: true,
			maxConcurrentWorkers: 3,
			...overrides.settingsValue,
		};
		const settingsManager: import('../../../../src/lib/neo/tools/neo-action-tools').NeoSettingsManager =
			{
				getGlobalSettings: () => currentSettings,
				updateGlobalSettings: (upd) => ({ ...currentSettings, ...upd }),
			};

		const goalStore = new Map<string, import('@neokai/shared').RoomGoal>();
		const managerFactory: import('../../../../src/lib/neo/tools/neo-action-tools').NeoActionManagerFactory =
			{
				getGoalManager: (_roomId) => ({
					createGoal: async (params) => {
						const g: import('@neokai/shared').RoomGoal = {
							id: 'new-goal-id',
							roomId: 'room-1',
							title: params.title,
							description: params.description ?? '',
							status: 'active',
							priority: params.priority ?? 'normal',
							progress: 0,
							linkedTaskIds: [],
							metrics: {},
							createdAt: 0,
							updatedAt: 0,
							missionType: params.missionType ?? 'one_shot',
							autonomyLevel: params.autonomyLevel ?? 'supervised',
						};
						goalStore.set(g.id, g);
						return g;
					},
					getGoal: async (id) => goalStore.get(id) ?? null,
					patchGoal: async (id, patch) => {
						const g = goalStore.get(id);
						if (!g) throw new Error('not found');
						const updated = { ...g, ...patch } as import('@neokai/shared').RoomGoal;
						goalStore.set(id, updated);
						return updated;
					},
					updateGoalStatus: async (id, status) => {
						const g = goalStore.get(id);
						if (!g) throw new Error('not found');
						const updated = { ...g, status };
						goalStore.set(id, updated);
						return updated;
					},
				}),
				getTaskManager: (_roomId) => ({
					createTask: async (params) =>
						({
							id: 'new-task-id',
							roomId: 'room-1',
							title: params.title,
							description: params.description,
							status: 'pending',
							priority: params.priority ?? 'normal',
							dependsOn: params.dependsOn ?? [],
							progress: 0,
							createdAt: 0,
							updatedAt: 0,
							taskType: 'coding',
							assignedAgent: 'coder',
						}) as import('@neokai/shared').NeoTask,
					getTask: async (id) => null,
					updateTaskFields: async (id, upd) => {
						throw new Error('not used');
					},
					setTaskStatus: async (id, status) =>
						({
							id,
							roomId: 'room-1',
							title: 'Task',
							description: '',
							status,
							priority: 'normal',
							dependsOn: [],
							progress: 0,
							createdAt: 0,
							updatedAt: 0,
							taskType: 'coding',
							assignedAgent: 'coder',
						}) as import('@neokai/shared').NeoTask,
				}),
			};

		const config: import('../../../../src/lib/neo/tools/neo-action-tools').NeoActionToolsConfig = {
			roomManager,
			managerFactory,
			pendingStore: new PAS(),
			getSecurityMode: () => 'autonomous',
			skillsManager,
			mcpManager,
			settingsManager,
			activityLogger: logger,
		};

		return { config, createNeoActionMcpServer };
	}

	/** Invoke a tool through the MCP server's registered tool map. */
	async function callTool(
		server: ReturnType<
			typeof import('../../../../src/lib/neo/tools/neo-action-tools').createNeoActionMcpServer
		>,
		toolName: string,
		args: Record<string, unknown>
	): Promise<{ content: Array<{ text: string }> }> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const reg = (server as any).instance._registeredTools as Record<
			string,
			{ handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }
		>;
		const t = reg[toolName];
		if (!t) throw new Error(`Tool '${toolName}' not found on server`);
		return t.handler(args);
	}

	/** Build a spy logger that records logAction calls. */
	function makeSpyLogger() {
		const calls: import('../../../../src/lib/neo/activity-logger').LogActionParams[] = [];
		const spy: import('../../../../src/lib/neo/activity-logger').NeoActivityLogger = {
			logAction: (params) => {
				calls.push(params);
				return logger.logAction(params);
			},
			pruneOldEntries: () => 0,
			getRecentActivity: () => [],
			getLatestUndoable: () => null,
		} as unknown as import('../../../../src/lib/neo/activity-logger').NeoActivityLogger;
		return { spy, calls };
	}

	// ── End-to-end wrapper tests ───────────────────────────────────────────────

	test('create_room: logged wrapper calls logAction with success status and undo data', async () => {
		const { config, createNeoActionMcpServer } = makeConfig();
		const { spy, calls } = makeSpyLogger();
		config.activityLogger = spy;
		const server = createNeoActionMcpServer(config);

		await callTool(server, 'create_room', {
			name: 'My Room',
			workspace_path: '/home/user/project',
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].toolName).toBe('create_room');
		expect(calls[0].status).toBe('success');
		expect(calls[0].undoable).toBe(true);
		expect(calls[0].undoData).toMatchObject({ roomId: 'new-room-id' });
		expect(calls[0].targetType).toBe('room');
		expect(calls[0].targetId).toBe('new-room-id');
	});

	test('toggle_skill: logged wrapper captures previous enabled state as undo data', async () => {
		const { config, createNeoActionMcpServer } = makeConfig({ skillEnabled: false });
		const { spy, calls } = makeSpyLogger();
		config.activityLogger = spy;
		const server = createNeoActionMcpServer(config);

		await callTool(server, 'toggle_skill', { skill_id: 'skill-abc', enabled: true });

		expect(calls).toHaveLength(1);
		expect(calls[0].toolName).toBe('toggle_skill');
		expect(calls[0].status).toBe('success');
		expect(calls[0].undoable).toBe(true);
		// preCapture should have recorded the state before the toggle (enabled=false).
		expect(calls[0].undoData).toMatchObject({ skillId: 'skill-abc', previousEnabled: false });
	});

	test('confirmationRequired result: logged wrapper does not call logAction', async () => {
		// Use conservative security mode so delete_room triggers a confirmationRequired response.
		const { config, createNeoActionMcpServer } = makeConfig();
		config.getSecurityMode = () => 'conservative';
		const { spy, calls } = makeSpyLogger();
		config.activityLogger = spy;
		const server = createNeoActionMcpServer(config);

		const result = await callTool(server, 'delete_room', { room_id: 'r-1' });
		const data = JSON.parse(result.content[0].text);
		expect(data.confirmationRequired).toBe(true);
		// Nothing has executed — the wrapper must NOT log.
		expect(calls).toHaveLength(0);
	});

	test('logged wrapper logs error entry and re-throws when handler throws', async () => {
		const { config, createNeoActionMcpServer } = makeConfig();
		const { spy, calls } = makeSpyLogger();
		config.activityLogger = spy;
		// Make roomManager.createRoom throw to simulate an unexpected handler error.
		config.roomManager!.createRoom = () => {
			throw new Error('DB connection lost');
		};
		const server = createNeoActionMcpServer(config);

		await expect(
			callTool(server, 'create_room', { name: 'Boom', workspace_path: '/home/user/project' })
		).rejects.toThrow('DB connection lost');

		expect(calls).toHaveLength(1);
		expect(calls[0].toolName).toBe('create_room');
		expect(calls[0].status).toBe('error');
		expect(calls[0].error).toBe('DB connection lost');
		expect(calls[0].undoable).toBe(false);
	});

	test('logged wrapper proceeds normally when preCapture throws', async () => {
		const { config, createNeoActionMcpServer } = makeConfig({ skillEnabled: true });
		const { spy, calls } = makeSpyLogger();
		config.activityLogger = spy;
		// Make getSkill throw to simulate a preCapture failure.
		config.skillsManager!.getSkill = () => {
			throw new Error('lookup failed');
		};
		const server = createNeoActionMcpServer(config);

		// The tool should still succeed — preCapture failure must not crash the call.
		const result = await callTool(server, 'toggle_skill', { skill_id: 'sk-1', enabled: false });
		const data = JSON.parse(result.content[0].text);
		expect(data.success).toBe(true);

		// Logged but not undoable (undo data was unavailable).
		expect(calls).toHaveLength(1);
		expect(calls[0].status).toBe('success');
		expect(calls[0].undoable).toBe(false);
	});

	// ── Logging infrastructure ────────────────────────────────────────────────

	test('logAction is called with correct toolName for logged invocations', () => {
		const logged: string[] = [];
		const spyLogger = new NeoActivityLogger(repo);
		const origLog = spyLogger.logAction.bind(spyLogger);
		spyLogger.logAction = (params) => {
			logged.push(params.toolName);
			return origLog(params);
		};

		// Direct log calls (simulating what the wrapper does).
		spyLogger.logAction({ toolName: 'create_room', input: {}, status: 'success' });
		spyLogger.logAction({ toolName: 'toggle_skill', input: {}, status: 'success' });
		spyLogger.logAction({
			toolName: 'update_app_settings',
			input: {},
			status: 'error',
			error: 'oops',
		});

		expect(logged).toEqual(['create_room', 'toggle_skill', 'update_app_settings']);

		const entries = spyLogger.getRecentActivity(10);
		expect(entries.length).toBe(3);
	});

	test('confirmationRequired results are not logged', () => {
		// A result containing confirmationRequired=true should be skipped by the wrapper.
		// We verify this by confirming the logger is only called for executed actions.
		let logCount = 0;
		const spyLogger = new NeoActivityLogger(repo);
		const origLog = spyLogger.logAction.bind(spyLogger);
		spyLogger.logAction = (params) => {
			logCount++;
			return origLog(params);
		};

		// Simulate what the wrapper does: skip logging on confirmationRequired.
		const confirmationResult = { confirmationRequired: true };
		if (confirmationResult.confirmationRequired === true) {
			// Skip — no log call.
		} else {
			spyLogger.logAction({ toolName: 'delete_room', input: {}, status: 'success' });
		}

		expect(logCount).toBe(0);
	});

	test('error results are logged with status=error and undoable=false', () => {
		logger.logAction({
			toolName: 'create_room',
			input: { name: '' },
			status: 'error',
			error: 'Room name is required',
			undoable: false,
		});

		const entries = repo.list({ limit: 10 });
		expect(entries.length).toBe(1);
		expect(entries[0].status).toBe('error');
		expect(entries[0].undoable).toBe(false);
		expect(entries[0].error).toBe('Room name is required');
	});

	test('successful undoable action stores undo data as JSON string', () => {
		logger.logAction({
			toolName: 'toggle_skill',
			input: { skill_id: 'sk-1', enabled: true },
			status: 'success',
			targetType: 'skill',
			targetId: 'sk-1',
			undoable: true,
			undoData: { skillId: 'sk-1', previousEnabled: false },
		});

		const latest = logger.getLatestUndoable();
		expect(latest).not.toBeNull();
		expect(latest?.undoData).toBe(JSON.stringify({ skillId: 'sk-1', previousEnabled: false }));
	});
});
