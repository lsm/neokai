/**
 * Unit tests for App MCP RPC Handlers
 *
 * Part 1: App MCP Registry RPC Handlers (registerAppMcpHandlers)
 * Covers:
 * - mcp.registry.list
 * - mcp.registry.get
 * - mcp.registry.create
 * - mcp.registry.update
 * - mcp.registry.delete
 * - mcp.registry.setEnabled
 *
 * Note: mcp.registry.listErrors is handled by mcp-handlers.ts and tested separately.
 *
 * Uses mock DB repository and mock DaemonHub to verify:
 * - Correct repo methods are called with correct arguments
 * - mcp.registry.changed event is emitted on write operations
 * - Validation errors are thrown for bad input
 *
 * Part 2: Per-Room MCP Enablement RPC Handlers (setupAppMcpHandlers)
 * Tests for mcp.room.getEnabled, mcp.room.setEnabled, and mcp.room.resetToGlobal
 * using an in-memory SQLite database and mock MessageHub / DaemonHub.
 */

import { describe, expect, it, test, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../../src/storage/schema';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import { RoomMcpEnablementRepository } from '../../../../src/storage/repositories/room-mcp-enablement-repository';
import type { MessageHub } from '@neokai/shared';
import {
	registerAppMcpHandlers,
	setupAppMcpHandlers,
	type AppMcpHandlerContext,
} from '../../../../src/lib/rpc-handlers/app-mcp-handlers';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { AppMcpServer } from '@neokai/shared';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { Database } from '../../../../src/storage/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RequestHandler = (data: unknown, context?: unknown) => unknown;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MCP_ENTRY: AppMcpServer = {
	id: 'aaaaaaaa-0000-4000-8000-000000000001',
	name: 'brave-search',
	description: 'Brave Search MCP',
	sourceType: 'stdio',
	command: 'npx',
	args: ['@modelcontextprotocol/server-brave-search'],
	env: { BRAVE_API_KEY: 'test-key' },
	enabled: true,
	createdAt: 1000,
	updatedAt: 1000,
};

// ---------------------------------------------------------------------------
// Mock factories (shared)
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
		onClientDisconnect: mock(() => () => {}),
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
// Part 1: Registry handler mock factories
// ---------------------------------------------------------------------------

function createMockDaemonHubForRegistry(): {
	daemonHub: DaemonHub;
	emit: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emit: emitMock };
}

function createMockRepo() {
	return {
		list: mock(() => [MCP_ENTRY]),
		create: mock(() => MCP_ENTRY),
		get: mock(() => MCP_ENTRY),
		getByName: mock(() => null),
		update: mock(() => MCP_ENTRY),
		delete: mock(() => true),
		isNameTaken: mock(() => false),
		listEnabled: mock(() => [MCP_ENTRY]),
	};
}

function buildContext(overrides?: {
	repo?: ReturnType<typeof createMockRepo>;
	emit?: ReturnType<typeof mock>;
	daemonHub?: DaemonHub;
}): {
	ctx: AppMcpHandlerContext;
	repo: ReturnType<typeof createMockRepo>;
	emit: ReturnType<typeof mock>;
	daemonHub: DaemonHub;
} {
	const repo = overrides?.repo ?? createMockRepo();
	const { daemonHub, emit } = overrides?.daemonHub
		? { daemonHub: overrides.daemonHub, emit: overrides.emit! }
		: createMockDaemonHubForRegistry();

	const ctx: AppMcpHandlerContext = {
		db: { appMcpServers: repo } as AppMcpHandlerContext['db'],
		daemonHub,
	};
	return { ctx, repo, emit, daemonHub };
}

// ---------------------------------------------------------------------------
// Part 1 Tests: Registry handlers
// ---------------------------------------------------------------------------

describe('mcp.registry.list', () => {
	let handlers: Map<string, RequestHandler>;
	let repo: ReturnType<typeof createMockRepo>;

	beforeEach(() => {
		const { hub, handlers: h } = createMockMessageHub();
		const { ctx, repo: r } = buildContext();
		repo = r;
		handlers = h;
		registerAppMcpHandlers(hub, ctx);
	});

	it('registers mcp.registry.list handler', () => {
		expect(handlers.has('mcp.registry.list')).toBe(true);
	});

	it('returns all servers from repo', async () => {
		const handler = handlers.get('mcp.registry.list')!;
		const result = (await handler({}, {})) as { servers: AppMcpServer[] };
		expect(result.servers).toHaveLength(1);
		expect(result.servers[0].name).toBe('brave-search');
		expect(repo.list).toHaveBeenCalledTimes(1);
	});
});

describe('mcp.registry.get', () => {
	let handlers: Map<string, RequestHandler>;
	let repo: ReturnType<typeof createMockRepo>;

	beforeEach(() => {
		const { hub, handlers: h } = createMockMessageHub();
		const { ctx, repo: r } = buildContext();
		repo = r;
		handlers = h;
		registerAppMcpHandlers(hub, ctx);
	});

	it('registers mcp.registry.get handler', () => {
		expect(handlers.has('mcp.registry.get')).toBe(true);
	});

	it('returns the server by id', async () => {
		const handler = handlers.get('mcp.registry.get')!;
		const result = (await handler({ id: MCP_ENTRY.id }, {})) as { server: AppMcpServer };
		expect(repo.get).toHaveBeenCalledWith(MCP_ENTRY.id);
		expect(result.server.name).toBe('brave-search');
	});

	it('throws if id is missing', async () => {
		const handler = handlers.get('mcp.registry.get')!;
		await expect(handler({}, {})).rejects.toThrow('id is required');
	});

	it('throws if entry not found', async () => {
		const repo = createMockRepo();
		repo.get = mock(() => null);
		const { hub, handlers: h } = createMockMessageHub();
		const { ctx } = buildContext({ repo });
		registerAppMcpHandlers(hub, ctx);
		const handler = h.get('mcp.registry.get')!;
		await expect(handler({ id: 'nonexistent' }, {})).rejects.toThrow('MCP server not found');
	});
});

describe('mcp.registry.create', () => {
	let handlers: Map<string, RequestHandler>;
	let repo: ReturnType<typeof createMockRepo>;
	let emit: ReturnType<typeof mock>;

	beforeEach(() => {
		const { hub, handlers: h } = createMockMessageHub();
		const { ctx, repo: r, emit: e } = buildContext();
		repo = r;
		emit = e;
		handlers = h;
		registerAppMcpHandlers(hub, ctx);
	});

	it('creates entry and returns it', async () => {
		const handler = handlers.get('mcp.registry.create')!;
		const payload = {
			name: 'brave-search',
			sourceType: 'stdio' as const,
			command: 'npx',
			args: ['@modelcontextprotocol/server-brave-search'],
		};
		const result = (await handler(payload, {})) as { server: AppMcpServer };
		expect(repo.create).toHaveBeenCalledWith(payload);
		expect(result.server.name).toBe('brave-search');
	});

	it('emits mcp.registry.changed on create', async () => {
		const handler = handlers.get('mcp.registry.create')!;
		await handler({ name: 'x', sourceType: 'stdio' }, {});
		expect(emit).toHaveBeenCalledWith('mcp.registry.changed', { sessionId: 'global' });
	});

	it('throws if name is missing', async () => {
		const handler = handlers.get('mcp.registry.create')!;
		await expect(handler({ sourceType: 'stdio' }, {})).rejects.toThrow('name is required');
	});

	it('throws if name is blank', async () => {
		const handler = handlers.get('mcp.registry.create')!;
		await expect(handler({ name: '   ', sourceType: 'stdio' }, {})).rejects.toThrow(
			'name is required'
		);
	});

	it('throws if sourceType is missing', async () => {
		const handler = handlers.get('mcp.registry.create')!;
		await expect(handler({ name: 'foo' }, {})).rejects.toThrow('sourceType is required');
	});
});

describe('mcp.registry.update', () => {
	let handlers: Map<string, RequestHandler>;
	let repo: ReturnType<typeof createMockRepo>;
	let emit: ReturnType<typeof mock>;

	beforeEach(() => {
		const { hub, handlers: h } = createMockMessageHub();
		const { ctx, repo: r, emit: e } = buildContext();
		repo = r;
		emit = e;
		handlers = h;
		registerAppMcpHandlers(hub, ctx);
	});

	it('calls repo.update with id and updates', async () => {
		const handler = handlers.get('mcp.registry.update')!;
		const payload = { id: MCP_ENTRY.id, name: 'renamed' };
		const result = (await handler(payload, {})) as { server: AppMcpServer };
		expect(repo.update).toHaveBeenCalledWith(MCP_ENTRY.id, { name: 'renamed' });
		expect(result.server).toBeDefined();
	});

	it('emits mcp.registry.changed on update', async () => {
		const handler = handlers.get('mcp.registry.update')!;
		await handler({ id: MCP_ENTRY.id, name: 'renamed' }, {});
		expect(emit).toHaveBeenCalledWith('mcp.registry.changed', { sessionId: 'global' });
	});

	it('does NOT emit changed when no update fields are provided (no-op)', async () => {
		const handler = handlers.get('mcp.registry.update')!;
		// Only id, no actual update fields
		await handler({ id: MCP_ENTRY.id }, {});
		expect(emit).not.toHaveBeenCalled();
	});

	it('throws if id is missing', async () => {
		const handler = handlers.get('mcp.registry.update')!;
		await expect(handler({ name: 'foo' }, {})).rejects.toThrow('id is required');
	});

	it('throws if entry not found', async () => {
		const repo = createMockRepo();
		repo.update = mock(() => null);
		const { hub, handlers: h } = createMockMessageHub();
		const { ctx } = buildContext({ repo });
		registerAppMcpHandlers(hub, ctx);
		const handler = h.get('mcp.registry.update')!;
		await expect(handler({ id: 'nonexistent-id' }, {})).rejects.toThrow('MCP server not found');
	});
});

describe('mcp.registry.delete', () => {
	let handlers: Map<string, RequestHandler>;
	let repo: ReturnType<typeof createMockRepo>;
	let emit: ReturnType<typeof mock>;

	beforeEach(() => {
		const { hub, handlers: h } = createMockMessageHub();
		const { ctx, repo: r, emit: e } = buildContext();
		repo = r;
		emit = e;
		handlers = h;
		registerAppMcpHandlers(hub, ctx);
	});

	it('deletes entry and returns success', async () => {
		const handler = handlers.get('mcp.registry.delete')!;
		const result = (await handler({ id: MCP_ENTRY.id }, {})) as { success: boolean };
		expect(repo.delete).toHaveBeenCalledWith(MCP_ENTRY.id);
		expect(result.success).toBe(true);
	});

	it('emits mcp.registry.changed on delete', async () => {
		const handler = handlers.get('mcp.registry.delete')!;
		await handler({ id: MCP_ENTRY.id }, {});
		expect(emit).toHaveBeenCalledWith('mcp.registry.changed', { sessionId: 'global' });
	});

	it('throws if id is missing', async () => {
		const handler = handlers.get('mcp.registry.delete')!;
		await expect(handler({}, {})).rejects.toThrow('id is required');
	});

	it('throws if entry not found', async () => {
		const repo = createMockRepo();
		repo.delete = mock(() => false);
		const { hub, handlers: h } = createMockMessageHub();
		const { ctx } = buildContext({ repo });
		registerAppMcpHandlers(hub, ctx);
		const handler = h.get('mcp.registry.delete')!;
		await expect(handler({ id: 'nonexistent-id' }, {})).rejects.toThrow('MCP server not found');
	});
});

describe('mcp.registry.setEnabled', () => {
	let handlers: Map<string, RequestHandler>;
	let repo: ReturnType<typeof createMockRepo>;
	let emit: ReturnType<typeof mock>;

	beforeEach(() => {
		const { hub, handlers: h } = createMockMessageHub();
		const { ctx, repo: r, emit: e } = buildContext();
		repo = r;
		emit = e;
		handlers = h;
		registerAppMcpHandlers(hub, ctx);
	});

	it('calls repo.update with enabled flag', async () => {
		const handler = handlers.get('mcp.registry.setEnabled')!;
		const result = (await handler({ id: MCP_ENTRY.id, enabled: false }, {})) as {
			server: AppMcpServer;
		};
		expect(repo.update).toHaveBeenCalledWith(MCP_ENTRY.id, { enabled: false });
		expect(result.server).toBeDefined();
	});

	it('emits mcp.registry.changed on toggle', async () => {
		const handler = handlers.get('mcp.registry.setEnabled')!;
		await handler({ id: MCP_ENTRY.id, enabled: false }, {});
		expect(emit).toHaveBeenCalledWith('mcp.registry.changed', { sessionId: 'global' });
	});

	it('throws if id is missing', async () => {
		const handler = handlers.get('mcp.registry.setEnabled')!;
		await expect(handler({ enabled: true }, {})).rejects.toThrow('id is required');
	});

	it('throws if enabled is not boolean', async () => {
		const handler = handlers.get('mcp.registry.setEnabled')!;
		await expect(handler({ id: MCP_ENTRY.id, enabled: 'yes' }, {})).rejects.toThrow(
			'enabled must be a boolean'
		);
	});

	it('throws if entry not found', async () => {
		const repo = createMockRepo();
		repo.update = mock(() => null);
		const { hub, handlers: h } = createMockMessageHub();
		const { ctx } = buildContext({ repo });
		registerAppMcpHandlers(hub, ctx);
		const handler = h.get('mcp.registry.setEnabled')!;
		await expect(handler({ id: 'nonexistent', enabled: true }, {})).rejects.toThrow(
			'MCP server not found'
		);
	});
});

// ---------------------------------------------------------------------------
// Part 2: Per-room enablement handler mock factories
// ---------------------------------------------------------------------------

function createMockDaemonHub(): { hub: DaemonHub; emitSpy: ReturnType<typeof mock> } {
	const emitSpy = mock(async () => {});
	const hub = {
		emit: emitSpy,
		on: mock(() => () => {}),
		off: mock(() => {}),
	} as unknown as DaemonHub;
	return { hub, emitSpy };
}

// ---------------------------------------------------------------------------
// Part 2 Tests: Per-room enablement handlers
// ---------------------------------------------------------------------------

describe('setupAppMcpHandlers', () => {
	let bunDb: BunDatabase;
	let reactiveDb: ReactiveDatabase;
	let appMcpRepo: AppMcpServerRepository;
	let roomMcpRepo: RoomMcpEnablementRepository;
	let handlers: Map<string, RequestHandler>;
	let emitSpy: ReturnType<typeof mock>;

	const ROOM_ID = 'room-test-123';

	beforeEach(() => {
		bunDb = new BunDatabase(':memory:');
		bunDb.exec('PRAGMA foreign_keys = ON');
		createTables(bunDb);

		// Insert the test room required by the FK on room_mcp_enablement.room_id
		const now = Date.now();
		bunDb
			.prepare(`INSERT INTO rooms (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
			.run(ROOM_ID, 'test-room', now, now);

		reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
		reactiveDb.notifyChange = mock(() => {});

		appMcpRepo = new AppMcpServerRepository(bunDb, reactiveDb);
		roomMcpRepo = new RoomMcpEnablementRepository(bunDb, reactiveDb);

		// Build a minimal Database stub that exposes what the handlers need
		const db = {
			appMcpServers: appMcpRepo,
			roomMcpEnablement: roomMcpRepo,
		} as unknown as Database;

		const { hub, handlers: h } = createMockMessageHub();
		const { hub: daemonHub, emitSpy: spy } = createMockDaemonHub();
		handlers = h;
		emitSpy = spy;

		setupAppMcpHandlers(hub, daemonHub, db);
	});

	afterEach(() => {
		bunDb.close();
	});

	// Helper
	function createServer(name: string) {
		return appMcpRepo.create({ name, sourceType: 'stdio', command: 'npx' });
	}

	// ---------------------------------------------------------------------------
	// mcp.room.getEnabled
	// ---------------------------------------------------------------------------

	describe('mcp.room.getEnabled', () => {
		test('returns empty serverIds when no overrides exist', () => {
			const handler = handlers.get('mcp.room.getEnabled')!;
			const result = handler({ roomId: ROOM_ID }) as { serverIds: string[] };
			expect(result.serverIds).toEqual([]);
		});

		test('returns IDs of enabled servers', () => {
			const srv1 = createServer('srv-get-1');
			const srv2 = createServer('srv-get-2');
			roomMcpRepo.setEnabled(ROOM_ID, srv1.id, true);
			roomMcpRepo.setEnabled(ROOM_ID, srv2.id, false);

			const handler = handlers.get('mcp.room.getEnabled')!;
			const result = handler({ roomId: ROOM_ID }) as { serverIds: string[] };
			expect(result.serverIds).toContain(srv1.id);
			expect(result.serverIds).not.toContain(srv2.id);
		});
	});

	// ---------------------------------------------------------------------------
	// mcp.room.setEnabled
	// ---------------------------------------------------------------------------

	describe('mcp.room.setEnabled', () => {
		test('enables a server and returns ok:true', () => {
			const srv = createServer('set-enabled');
			const handler = handlers.get('mcp.room.setEnabled')!;
			const result = handler({ roomId: ROOM_ID, serverId: srv.id, enabled: true }) as {
				ok: boolean;
			};
			expect(result.ok).toBe(true);
			expect(roomMcpRepo.getEnabledServerIds(ROOM_ID)).toContain(srv.id);
		});

		test('disables a server', () => {
			const srv = createServer('set-disabled');
			const handler = handlers.get('mcp.room.setEnabled')!;
			handler({ roomId: ROOM_ID, serverId: srv.id, enabled: false });
			expect(roomMcpRepo.getEnabledServerIds(ROOM_ID)).not.toContain(srv.id);
		});

		test('emits mcp.registry.changed after write', async () => {
			const srv = createServer('emit-test');
			const handler = handlers.get('mcp.room.setEnabled')!;
			emitSpy.mockClear();
			handler({ roomId: ROOM_ID, serverId: srv.id, enabled: true });

			// Wait for the async emit to resolve
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			expect(emitSpy).toHaveBeenCalledWith('mcp.registry.changed', { sessionId: 'global' });
		});

		test('throws when server does not exist', () => {
			const handler = handlers.get('mcp.room.setEnabled')!;
			expect(() => handler({ roomId: ROOM_ID, serverId: 'nonexistent-id', enabled: true })).toThrow(
				'MCP server not found'
			);
		});
	});

	// ---------------------------------------------------------------------------
	// mcp.room.resetToGlobal
	// ---------------------------------------------------------------------------

	describe('mcp.room.resetToGlobal', () => {
		test('removes all overrides and returns ok:true', () => {
			const srv1 = createServer('reset-srv1');
			const srv2 = createServer('reset-srv2');
			roomMcpRepo.setEnabled(ROOM_ID, srv1.id, true);
			roomMcpRepo.setEnabled(ROOM_ID, srv2.id, true);

			const handler = handlers.get('mcp.room.resetToGlobal')!;
			const result = handler({ roomId: ROOM_ID }) as { ok: boolean };
			expect(result.ok).toBe(true);
			expect(roomMcpRepo.getEnabledServerIds(ROOM_ID)).toEqual([]);
		});

		test('emits mcp.registry.changed after write', async () => {
			const handler = handlers.get('mcp.room.resetToGlobal')!;
			emitSpy.mockClear();
			handler({ roomId: ROOM_ID });

			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			expect(emitSpy).toHaveBeenCalledWith('mcp.registry.changed', { sessionId: 'global' });
		});

		test('no-op for a room with no overrides — still returns ok:true', () => {
			const handler = handlers.get('mcp.room.resetToGlobal')!;
			const result = handler({ roomId: 'empty-room' }) as { ok: boolean };
			expect(result.ok).toBe(true);
		});
	});
});
