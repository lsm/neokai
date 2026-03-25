/**
 * Tests for RoomRuntimeService worker session MCP integration (Task 3.3).
 *
 * Verifies that:
 * 1. Worker sessions (coder/general) receive the merged (file-based + registry) MCP map
 *    via setRuntimeMcpServers() when createAndStartSession is called.
 * 2. File-based servers take precedence over registry servers on name collision.
 * 3. The merged map is complete — neither source is dropped.
 * 4. Non-worker roles (leader, planner) do NOT get the worker MCP injection.
 * 5. appMcpManager is optional — missing it does not throw.
 */

import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { McpServerConfig } from '@neokai/shared';
import type { AgentSessionInit } from '../../../src/lib/agent/agent-session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DaemonHubListener = (event: Record<string, unknown>) => void;

function makeDaemonHub() {
	const listeners = new Map<string, DaemonHubListener[]>();
	return {
		on: (event: string, handler: DaemonHubListener) => {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event)!.push(handler);
			return () => {
				const arr = listeners.get(event);
				if (arr) {
					const idx = arr.indexOf(handler);
					if (idx !== -1) arr.splice(idx, 1);
				}
			};
		},
		emit: async (event: string, payload: Record<string, unknown>) => {
			for (const handler of listeners.get(event) ?? []) {
				handler(payload);
			}
		},
	};
}

function makeMinimalInit(sessionId = 'session-1'): AgentSessionInit {
	return {
		sessionId,
		workspacePath: '/tmp',
		systemPrompt: { type: 'preset', preset: 'claude_code' },
		features: {
			rewind: false,
			worktree: false,
			coordinator: false,
			archive: false,
			sessionInfo: false,
		},
		type: 'coder',
		model: 'test-model',
	};
}

/**
 * Build a minimal SessionFactory that lets us observe calls to the underlying
 * AgentSession mock. Returns the factory and a collector for setRuntimeMcpServers calls.
 *
 * We exercise createAndStartSession by extracting the factory from a configured
 * RoomRuntimeService instance via the private createSessionFactory() method.
 */
async function buildSessionFactory(opts: {
	fileMcpServers?: Record<string, McpServerConfig>;
	registryMcpServers?: Record<string, McpServerConfig>;
	hasAppMcpManager?: boolean;
}) {
	const { fileMcpServers = {}, registryMcpServers = {}, hasAppMcpManager = true } = opts;

	// Capture setRuntimeMcpServers calls per session
	const setRuntimeMcpServersCalls = new Map<string, Array<Record<string, McpServerConfig>>>();

	// Mock AgentSession.fromInit to return a controllable stub
	const agentSessionModule = await import('../../../src/lib/agent/agent-session');
	const fromInitSpy = spyOn(agentSessionModule.AgentSession, 'fromInit').mockImplementation(((
		init: AgentSessionInit
	) => {
		const id = init.sessionId;
		if (!setRuntimeMcpServersCalls.has(id)) {
			setRuntimeMcpServersCalls.set(id, []);
		}
		return {
			setRuntimeMcpServers: (map: Record<string, McpServerConfig>) => {
				setRuntimeMcpServersCalls.get(id)!.push(map);
			},
			startStreamingQuery: mock(async () => {}),
			getProcessingState: () => ({ status: 'idle' }),
		} as never;
	}) as typeof agentSessionModule.AgentSession.fromInit);

	const settingsManager = {
		getEnabledMcpServersConfig: () => fileMcpServers,
	};

	const appMcpManager = hasAppMcpManager
		? { getEnabledMcpConfigs: () => registryMcpServers }
		: undefined;

	// Build a minimal RoomRuntimeService config
	const { RoomRuntimeService } = await import('../../../src/lib/room/runtime/room-runtime-service');

	const service = new RoomRuntimeService({
		db: {} as never,
		messageHub: {} as never,
		daemonHub: makeDaemonHub() as never,
		getApiKey: async () => null,
		roomManager: {
			listRooms: () => [],
			getRoom: () => null,
			updateRoom: () => null,
		} as never,
		sessionManager: {} as never,
		defaultWorkspacePath: '/tmp',
		defaultModel: 'test-model',
		getGlobalSettings: () => ({}) as never,
		settingsManager: settingsManager as never,
		appMcpManager: appMcpManager as never,
		reactiveDb: {} as never,
	});

	// Extract the private createSessionFactory method
	const factory = (
		service as unknown as {
			createSessionFactory: () => {
				createAndStartSession: (init: AgentSessionInit, role: string) => Promise<void>;
			};
		}
	).createSessionFactory();

	return { factory, setRuntimeMcpServersCalls, fromInitSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomRuntimeService worker session MCP merge', () => {
	it('injects merged MCP map into coder sessions', async () => {
		const fileServer: McpServerConfig = { type: 'stdio', command: 'file-cmd' };
		const registryServer: McpServerConfig = { type: 'stdio', command: 'registry-cmd' };

		const { factory, setRuntimeMcpServersCalls, fromInitSpy } = await buildSessionFactory({
			fileMcpServers: { 'file-mcp': fileServer },
			registryMcpServers: { 'registry-mcp': registryServer },
		});

		await factory.createAndStartSession(makeMinimalInit('s1'), 'coder');

		fromInitSpy.mockRestore();

		const calls = setRuntimeMcpServersCalls.get('s1') ?? [];
		expect(calls.length).toBe(1);
		expect(calls[0]!['file-mcp']).toEqual(fileServer);
		expect(calls[0]!['registry-mcp']).toEqual(registryServer);
	});

	it('injects merged MCP map into general sessions', async () => {
		const fileServer: McpServerConfig = { type: 'stdio', command: 'file-cmd' };
		const registryServer: McpServerConfig = { type: 'stdio', command: 'registry-cmd' };

		const { factory, setRuntimeMcpServersCalls, fromInitSpy } = await buildSessionFactory({
			fileMcpServers: { 'file-mcp': fileServer },
			registryMcpServers: { 'registry-mcp': registryServer },
		});

		const init = { ...makeMinimalInit('s2'), type: 'general' as const };
		await factory.createAndStartSession(init, 'general');

		fromInitSpy.mockRestore();

		const calls = setRuntimeMcpServersCalls.get('s2') ?? [];
		expect(calls.length).toBe(1);
		expect(calls[0]!['file-mcp']).toEqual(fileServer);
		expect(calls[0]!['registry-mcp']).toEqual(registryServer);
	});

	it('file-based server takes precedence over registry on name collision', async () => {
		const fileServer: McpServerConfig = { type: 'stdio', command: 'file-wins' };
		const registryServer: McpServerConfig = { type: 'stdio', command: 'registry-loses' };

		const { factory, setRuntimeMcpServersCalls, fromInitSpy } = await buildSessionFactory({
			fileMcpServers: { 'shared-name': fileServer },
			registryMcpServers: { 'shared-name': registryServer },
		});

		await factory.createAndStartSession(makeMinimalInit('s3'), 'coder');

		fromInitSpy.mockRestore();

		const calls = setRuntimeMcpServersCalls.get('s3') ?? [];
		expect(calls.length).toBe(1);
		const merged = calls[0]!;
		expect((merged['shared-name'] as McpServerConfig & { command?: string }).command).toBe(
			'file-wins'
		);
	});

	it('merged map contains both sources — neither is dropped', async () => {
		const fileServer: McpServerConfig = { type: 'stdio', command: 'file-only' };
		const registryServer: McpServerConfig = { type: 'stdio', command: 'registry-only' };

		const { factory, setRuntimeMcpServersCalls, fromInitSpy } = await buildSessionFactory({
			fileMcpServers: { 'file-unique': fileServer },
			registryMcpServers: { 'registry-unique': registryServer },
		});

		await factory.createAndStartSession(makeMinimalInit('s4'), 'coder');

		fromInitSpy.mockRestore();

		const calls = setRuntimeMcpServersCalls.get('s4') ?? [];
		expect(calls.length).toBe(1);
		const merged = calls[0]!;
		expect(merged['file-unique']).toEqual(fileServer);
		expect(merged['registry-unique']).toEqual(registryServer);
	});

	it('does NOT inject MCP servers for leader sessions', async () => {
		const fileServer: McpServerConfig = { type: 'stdio', command: 'file-cmd' };
		const registryServer: McpServerConfig = { type: 'stdio', command: 'registry-cmd' };

		const { factory, setRuntimeMcpServersCalls, fromInitSpy } = await buildSessionFactory({
			fileMcpServers: { 'file-mcp': fileServer },
			registryMcpServers: { 'registry-mcp': registryServer },
		});

		await factory.createAndStartSession(makeMinimalInit('s5'), 'leader');

		fromInitSpy.mockRestore();

		const calls = setRuntimeMcpServersCalls.get('s5') ?? [];
		// setRuntimeMcpServers should NOT be called for leader
		expect(calls.length).toBe(0);
	});

	it('does NOT inject MCP servers for planner sessions', async () => {
		const fileServer: McpServerConfig = { type: 'stdio', command: 'file-cmd' };

		const { factory, setRuntimeMcpServersCalls, fromInitSpy } = await buildSessionFactory({
			fileMcpServers: { 'file-mcp': fileServer },
		});

		await factory.createAndStartSession(makeMinimalInit('s6'), 'planner');

		fromInitSpy.mockRestore();

		const calls = setRuntimeMcpServersCalls.get('s6') ?? [];
		expect(calls.length).toBe(0);
	});

	it('works without appMcpManager — file-based servers are still injected', async () => {
		const fileServer: McpServerConfig = { type: 'stdio', command: 'file-only-cmd' };

		const { factory, setRuntimeMcpServersCalls, fromInitSpy } = await buildSessionFactory({
			fileMcpServers: { 'file-mcp': fileServer },
			hasAppMcpManager: false,
		});

		await factory.createAndStartSession(makeMinimalInit('s7'), 'coder');

		fromInitSpy.mockRestore();

		const calls = setRuntimeMcpServersCalls.get('s7') ?? [];
		expect(calls.length).toBe(1);
		expect(calls[0]!['file-mcp']).toEqual(fileServer);
	});

	it('injects empty map when both sources are empty (no MCP servers configured)', async () => {
		const { factory, setRuntimeMcpServersCalls, fromInitSpy } = await buildSessionFactory({
			fileMcpServers: {},
			registryMcpServers: {},
		});

		await factory.createAndStartSession(makeMinimalInit('s8'), 'coder');

		fromInitSpy.mockRestore();

		const calls = setRuntimeMcpServersCalls.get('s8') ?? [];
		// setRuntimeMcpServers is still called, but with an empty map
		expect(calls.length).toBe(1);
		expect(Object.keys(calls[0]!)).toHaveLength(0);
	});
});
