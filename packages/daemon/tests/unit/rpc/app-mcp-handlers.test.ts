/**
 * Unit tests for App MCP Registry RPC Handlers
 *
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
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import type { MessageHub } from '@neokai/shared';
import {
	registerAppMcpHandlers,
	type AppMcpHandlerContext,
} from '../../../src/lib/rpc-handlers/app-mcp-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { AppMcpServer } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

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
// Mock factories
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

function createMockDaemonHub(): {
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

// ---------------------------------------------------------------------------
// Helper — build handler context
// ---------------------------------------------------------------------------

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
		: createMockDaemonHub();

	const ctx: AppMcpHandlerContext = {
		db: { appMcpServers: repo } as AppMcpHandlerContext['db'],
		daemonHub,
	};
	return { ctx, repo, emit, daemonHub };
}

// ---------------------------------------------------------------------------
// Tests
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

	it('does NOT emit changed when no update fields are provided (no-op)', async () => {
		const handler = handlers.get('mcp.registry.update')!;
		// Only id, no actual update fields
		await handler({ id: MCP_ENTRY.id }, {});
		expect(emit).not.toHaveBeenCalled();
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
