/**
 * Room Workspace Isolation Integration Tests
 *
 * Verifies that the room lifecycle correctly uses each room's `defaultPath`
 * for workspace resolution — never falling back to the daemon's `workspaceRoot`.
 *
 * Tests:
 * 1. room.create sets chat session workspacePath = defaultPath (not workspaceRoot)
 * 2. @file / @folder reference resolution uses room's defaultPath, not workspaceRoot
 * 3. room.update with a new defaultPath updates the chat session's workspacePath
 * 4. room.update rejects defaultPath changes when tasks are active
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	setupRoomHandlers,
	type RoomHandlerOpts,
} from '../../../src/lib/rpc-handlers/room-handlers';
import {
	setupReferenceHandlers,
	type ReferenceHandlerDeps,
} from '../../../src/lib/rpc-handlers/reference-handlers';
import type { Database as BunDatabase } from 'bun:sqlite';
import type { ReactiveDatabase } from '../../../src/storage/reactive-database';
import type { ShortIdAllocator } from '../../../src/lib/short-id-allocator';
import type { FileIndex } from '../../../src/lib/file-index';
import { Database } from '../../../src/storage/database';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';
import { RoomManager } from '../../../src/lib/room/managers/room-manager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RequestHandler = (data: unknown) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Helpers: stub values for ReferenceHandlerDeps fields not used by
// reference.resolve (only consumed by reference.search). Providing
// explicit stubs here prevents confusing `undefined` errors if the
// implementation ever starts using these fields in resolve.
// ---------------------------------------------------------------------------

const stubDb = {} as unknown as BunDatabase;
const stubReactiveDb = {} as unknown as ReactiveDatabase;
const stubShortIdAllocator = {} as unknown as ShortIdAllocator;
const stubFileIndex = {} as unknown as FileIndex;

// ---------------------------------------------------------------------------
// Helpers: mock MessageHub
// ---------------------------------------------------------------------------

function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

// ---------------------------------------------------------------------------
// Helpers: mock DaemonHub
// ---------------------------------------------------------------------------

function createMockDaemonHub() {
	return {
		emit: mock(async () => {}),
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(() => () => {}),
	} as never;
}

// ---------------------------------------------------------------------------
// Helpers: mock SessionManager
// ---------------------------------------------------------------------------

/**
 * Creates a minimal SessionManager mock that tracks created and updated sessions
 * in an in-memory map. Enough to satisfy room-handlers.ts without a real DB.
 */
function createMockSessionManager() {
	// sessionId → session record
	const sessions = new Map<string, { workspacePath: string; config?: Record<string, unknown> }>();

	const mgr = {
		sessions,
		createSession: mock(
			async (opts: {
				sessionId: string;
				workspacePath: string;
				config?: Record<string, unknown>;
			}) => {
				sessions.set(opts.sessionId, {
					workspacePath: opts.workspacePath,
					config: opts.config,
				});
			}
		),
		getSessionFromDB: mock((sessionId: string) => {
			const s = sessions.get(sessionId);
			if (!s) return null;
			return {
				id: sessionId,
				workspacePath: s.workspacePath,
				config: s.config,
			};
		}),
		updateSession: mock(
			async (
				sessionId: string,
				updates: { workspacePath?: string; config?: Record<string, unknown> }
			) => {
				const existing = sessions.get(sessionId);
				if (!existing) return;
				if (updates.workspacePath !== undefined) {
					existing.workspacePath = updates.workspacePath;
				}
				if (updates.config !== undefined) {
					existing.config = updates.config;
				}
			}
		),
	};

	return mgr;
}

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

describe('room workspace isolation', () => {
	let db: Database;
	let roomManager: RoomManager;

	// Temp directory acting as the daemon's global workspaceRoot
	let daemonWorkspace: string;
	// Temp directory acting as the room's defaultPath
	let roomWorkspace: string;
	// A second room workspace for update tests
	let newRoomWorkspace: string;

	beforeEach(async () => {
		// Create a fresh in-memory SQLite for each test (room isolation)
		db = new Database(':memory:');
		const reactiveDb = createReactiveDatabase(db);
		await db.initialize(reactiveDb);
		roomManager = new RoomManager(db.getDatabase(), reactiveDb);

		// Create temp directories
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		daemonWorkspace = join(tmpdir(), `daemon-ws-${suffix}`);
		roomWorkspace = join(tmpdir(), `room-ws-${suffix}`);
		newRoomWorkspace = join(tmpdir(), `room-ws-new-${suffix}`);

		await mkdir(daemonWorkspace, { recursive: true });
		await mkdir(roomWorkspace, { recursive: true });
		await mkdir(newRoomWorkspace, { recursive: true });

		// Seed each workspace with a distinct fixture file so assertions can
		// tell which directory was actually searched.
		await writeFile(join(daemonWorkspace, 'daemon-only.txt'), 'daemon workspace file');
		await writeFile(join(roomWorkspace, 'room-only.txt'), 'room workspace file');
		await writeFile(join(newRoomWorkspace, 'new-room-only.txt'), 'new room workspace file');
	});

	afterEach(async () => {
		db.close();
		await rm(daemonWorkspace, { recursive: true, force: true });
		await rm(roomWorkspace, { recursive: true, force: true });
		await rm(newRoomWorkspace, { recursive: true, force: true });
	});

	// =========================================================================
	// Test 1: room.create sets session workspacePath = room's defaultPath
	// =========================================================================

	describe('room.create — workspacePath isolation', () => {
		it('sets the room chat session workspacePath to defaultPath, not daemonWorkspaceRoot', async () => {
			const { hub, handlers } = createMockMessageHub();
			const daemonHub = createMockDaemonHub();
			const sessionMgr = createMockSessionManager();

			setupRoomHandlers(hub, roomManager, daemonHub, sessionMgr as never);

			const createHandler = handlers.get('room.create')!;
			const result = (await createHandler({
				name: 'Test Room',
				defaultPath: roomWorkspace,
			})) as { room: { id: string } };

			const roomId = result.room.id;
			const chatSessionId = `room:chat:${roomId}`;

			// The session must have been created with the room's own defaultPath
			expect(sessionMgr.createSession).toHaveBeenCalledTimes(1);
			const createCall = sessionMgr.createSession.mock.calls[0][0] as {
				sessionId: string;
				workspacePath: string;
			};
			expect(createCall.sessionId).toBe(chatSessionId);
			expect(createCall.workspacePath).toBe(roomWorkspace);
			expect(createCall.workspacePath).not.toBe(daemonWorkspace);

			// The in-memory record should also reflect the room workspace
			const session = sessionMgr.sessions.get(chatSessionId);
			expect(session).toBeDefined();
			expect(session!.workspacePath).toBe(roomWorkspace);
			expect(session!.workspacePath).not.toBe(daemonWorkspace);
		});
	});

	// =========================================================================
	// Test 2: @file reference resolution uses room's defaultPath
	// =========================================================================

	describe('reference resolution — workspace isolation', () => {
		it('resolves @file within room defaultPath, not daemonWorkspaceRoot', async () => {
			// room-only.txt exists only in roomWorkspace; daemon-only.txt only in daemonWorkspace.
			// Resolving 'room-only.txt' via a room:chat:* session must find it.
			const { hub, handlers } = createMockMessageHub();

			// SessionManager that knows no sessions (room:chat:* is a synthetic id)
			const sessionMgr = { getSessionAsync: mock(async () => null) };

			const deps: ReferenceHandlerDeps = {
				db: stubDb,
				reactiveDb: stubReactiveDb,
				shortIdAllocator: stubShortIdAllocator,
				fileIndex: stubFileIndex,
				sessionManager: sessionMgr as never,
				taskRepo: { getTask: mock(() => null), getTaskByShortId: mock(() => null) },
				goalRepo: { getGoal: mock(() => null), getGoalByShortId: mock(() => null) },
				workspaceRoot: daemonWorkspace,
				// Provide room defaultPath via the callback (simulates Task 3.1 fix)
				getRoomDefaultPath: (roomId: string) => (roomId === 'room-42' ? roomWorkspace : undefined),
			};
			setupReferenceHandlers(hub, deps);

			const resolveHandler = handlers.get('reference.resolve')!;

			// Resolving a file that exists ONLY in roomWorkspace should succeed.
			// We assert `resolved !== null` (file was found) rather than checking byte
			// content: the existence and metadata checks use stat() and existsSync(),
			// neither of which is overridden by the readFile-only mock that
			// mcp-handlers.test.ts leaves behind via mock.module('node:fs/promises').
			// Bun's mock.module only overrides keys present in the factory's return
			// value; stat, open, and readdir retain their real implementations, so
			// null/not-null correctly proves which workspace was searched regardless
			// of any mock.module('node:fs/promises') contamination from other test
			// files in the same Bun process.
			const result = (await resolveHandler({
				sessionId: 'room:chat:room-42',
				type: 'file',
				id: 'room-only.txt',
			})) as { resolved: { type: string; id: string } | null };

			expect(result.resolved).not.toBeNull();
			expect(result.resolved!.type).toBe('file');
			expect(result.resolved!.id).toBe('room-only.txt');
		});

		it('does NOT find daemonWorkspaceRoot files when resolving in room context', async () => {
			// daemon-only.txt must NOT be accessible from the room's workspace.
			const { hub, handlers } = createMockMessageHub();
			const sessionMgr = { getSessionAsync: mock(async () => null) };

			const deps: ReferenceHandlerDeps = {
				db: stubDb,
				reactiveDb: stubReactiveDb,
				shortIdAllocator: stubShortIdAllocator,
				fileIndex: stubFileIndex,
				sessionManager: sessionMgr as never,
				taskRepo: { getTask: mock(() => null), getTaskByShortId: mock(() => null) },
				goalRepo: { getGoal: mock(() => null), getGoalByShortId: mock(() => null) },
				workspaceRoot: daemonWorkspace,
				getRoomDefaultPath: (_roomId: string) => roomWorkspace,
			};
			setupReferenceHandlers(hub, deps);

			const resolveHandler = handlers.get('reference.resolve')!;

			// daemon-only.txt exists in daemonWorkspace but NOT in roomWorkspace
			const result = (await resolveHandler({
				sessionId: 'room:chat:any-room',
				type: 'file',
				id: 'daemon-only.txt',
			})) as { resolved: unknown };

			// Must return null — the file is outside the room's workspace
			expect(result.resolved).toBeNull();
		});

		it('resolves @folder within room defaultPath', async () => {
			// Create a subdirectory only in the room workspace
			const subDir = join(roomWorkspace, 'src');
			await mkdir(subDir, { recursive: true });
			await writeFile(join(subDir, 'app.ts'), '// app');

			const { hub, handlers } = createMockMessageHub();
			const sessionMgr = { getSessionAsync: mock(async () => null) };

			const deps: ReferenceHandlerDeps = {
				db: stubDb,
				reactiveDb: stubReactiveDb,
				shortIdAllocator: stubShortIdAllocator,
				fileIndex: stubFileIndex,
				sessionManager: sessionMgr as never,
				taskRepo: { getTask: mock(() => null), getTaskByShortId: mock(() => null) },
				goalRepo: { getGoal: mock(() => null), getGoalByShortId: mock(() => null) },
				workspaceRoot: daemonWorkspace,
				getRoomDefaultPath: (_roomId: string) => roomWorkspace,
			};
			setupReferenceHandlers(hub, deps);

			const resolveHandler = handlers.get('reference.resolve')!;

			const result = (await resolveHandler({
				sessionId: 'room:chat:any-room',
				type: 'folder',
				id: 'src',
			})) as {
				resolved: { data: { entries: Array<{ name: string }> } } | null;
			};

			expect(result.resolved).not.toBeNull();
			const names = result.resolved!.data.entries.map((e) => e.name);
			expect(names).toContain('app.ts');
		});
	});

	// =========================================================================
	// Test 3: room.update changes session workspacePath when defaultPath changes
	// =========================================================================

	describe('room.update — workspacePath propagation', () => {
		it('updates the room chat session workspacePath when defaultPath changes (no active tasks)', async () => {
			const { hub, handlers } = createMockMessageHub();
			const daemonHub = createMockDaemonHub();
			const sessionMgr = createMockSessionManager();

			const opts: RoomHandlerOpts = {
				hasActiveTaskGroups: mock(() => false),
			};

			setupRoomHandlers(
				hub,
				roomManager,
				daemonHub,
				sessionMgr as never,
				undefined,
				undefined,
				opts
			);

			// First, create the room with the original roomWorkspace
			const createHandler = handlers.get('room.create')!;
			const createResult = (await createHandler({
				name: 'Update Test Room',
				defaultPath: roomWorkspace,
			})) as { room: { id: string } };

			const roomId = createResult.room.id;
			const chatSessionId = `room:chat:${roomId}`;

			// Confirm initial workspacePath
			expect(sessionMgr.sessions.get(chatSessionId)!.workspacePath).toBe(roomWorkspace);

			// Now update defaultPath to newRoomWorkspace
			const updateHandler = handlers.get('room.update')!;
			await updateHandler({
				roomId,
				defaultPath: newRoomWorkspace,
			});

			// The session workspacePath must be updated to the new path
			expect(sessionMgr.updateSession).toHaveBeenCalled();
			const updatedSession = sessionMgr.sessions.get(chatSessionId);
			expect(updatedSession).toBeDefined();
			expect(updatedSession!.workspacePath).toBe(newRoomWorkspace);
			expect(updatedSession!.workspacePath).not.toBe(roomWorkspace);
		});

		it('does NOT call updateSession when defaultPath is unchanged', async () => {
			const { hub, handlers } = createMockMessageHub();
			const daemonHub = createMockDaemonHub();
			const sessionMgr = createMockSessionManager();

			const opts: RoomHandlerOpts = {
				hasActiveTaskGroups: mock(() => false),
			};

			setupRoomHandlers(
				hub,
				roomManager,
				daemonHub,
				sessionMgr as never,
				undefined,
				undefined,
				opts
			);

			const createResult = (await handlers.get('room.create')!({
				name: 'No-Change Room',
				defaultPath: roomWorkspace,
			})) as { room: { id: string } };

			const roomId = createResult.room.id;

			// Reset mock call count after create (which calls updateSession 0 times, but let's be explicit)
			sessionMgr.updateSession.mockClear();

			// Update with the SAME defaultPath
			await handlers.get('room.update')!({
				roomId,
				defaultPath: roomWorkspace,
				name: 'No-Change Room (renamed)',
			});

			// updateSession should NOT have been called for workspacePath
			// (it may be called for other reasons like defaultModel, but not workspacePath)
			const workspaceUpdateCalls = sessionMgr.updateSession.mock.calls.filter(
				(args: unknown[]) => (args[1] as { workspacePath?: string }).workspacePath !== undefined
			);
			expect(workspaceUpdateCalls).toHaveLength(0);
		});
	});

	// =========================================================================
	// Test 4: room.update rejects defaultPath change when tasks are active
	// =========================================================================

	describe('room.update — active task guard', () => {
		it('rejects defaultPath change when tasks are active', async () => {
			const { hub, handlers } = createMockMessageHub();
			const daemonHub = createMockDaemonHub();
			const sessionMgr = createMockSessionManager();

			const opts: RoomHandlerOpts = {
				// Simulate active tasks
				hasActiveTaskGroups: mock(() => true),
			};

			setupRoomHandlers(
				hub,
				roomManager,
				daemonHub,
				sessionMgr as never,
				undefined,
				undefined,
				opts
			);

			// Create room first
			const createResult = (await handlers.get('room.create')!({
				name: 'Active Task Room',
				defaultPath: roomWorkspace,
			})) as { room: { id: string } };

			const roomId = createResult.room.id;

			// Attempt to change defaultPath while tasks are active
			await expect(
				handlers.get('room.update')!({
					roomId,
					defaultPath: newRoomWorkspace,
				})
			).rejects.toThrow(
				'Cannot change defaultPath while tasks are active. Stop or complete all tasks first.'
			);

			// Session workspacePath must remain unchanged
			const chatSessionId = `room:chat:${roomId}`;
			const session = sessionMgr.sessions.get(chatSessionId);
			expect(session!.workspacePath).toBe(roomWorkspace);
		});

		it('allows defaultPath change when no tasks are active', async () => {
			const { hub, handlers } = createMockMessageHub();
			const daemonHub = createMockDaemonHub();
			const sessionMgr = createMockSessionManager();

			const opts: RoomHandlerOpts = {
				hasActiveTaskGroups: mock(() => false),
			};

			setupRoomHandlers(
				hub,
				roomManager,
				daemonHub,
				sessionMgr as never,
				undefined,
				undefined,
				opts
			);

			const createResult = (await handlers.get('room.create')!({
				name: 'Idle Room',
				defaultPath: roomWorkspace,
			})) as { room: { id: string } };

			const roomId = createResult.room.id;

			// Should resolve without error
			await expect(
				handlers.get('room.update')!({
					roomId,
					defaultPath: newRoomWorkspace,
				})
			).resolves.toBeDefined();

			// workspacePath must be updated
			const chatSessionId = `room:chat:${roomId}`;
			expect(sessionMgr.sessions.get(chatSessionId)!.workspacePath).toBe(newRoomWorkspace);
		});
	});
});
