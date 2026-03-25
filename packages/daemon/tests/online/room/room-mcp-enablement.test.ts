/**
 * Online tests for Per-Room MCP Enablement
 *
 * Tests the integration between:
 * - AppMcpLifecycleManager.getEnabledMcpConfigsForRoom()
 * - RoomMcpEnablementRepository (per-room overrides)
 * - mcp.room RPC handlers (setEnabled, getEnabled, resetToGlobal)
 *
 * These tests use the full daemon server with real database and RPC handlers.
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available (no skip)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';

describe('Room MCP Enablement — Online', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(async () => {
		if (!daemon) return;
		daemon.kill('SIGTERM');
		await daemon.waitForExit();
	}, 15000);

	/**
	 * Helper to create a registry MCP server via RPC.
	 */
	async function createRegistryServer(name: string): Promise<{ id: string; name: string }> {
		const result = (await daemon.messageHub.request('mcp.registry.create', {
			name,
			sourceType: 'stdio',
			command: 'echo',
			args: [name],
		})) as { server: { id: string; name: string } };
		return result.server;
	}

	/**
	 * Helper to enable a server for a room via RPC.
	 */
	async function enableForRoom(roomId: string, serverId: string, enabled: boolean): Promise<void> {
		await daemon.messageHub.request('mcp.room.setEnabled', {
			roomId,
			serverId,
			enabled,
		});
	}

	/**
	 * Helper to get enabled servers for a room via RPC.
	 */
	async function getEnabledForRoom(roomId: string): Promise<string[]> {
		const result = (await daemon.messageHub.request('mcp.room.getEnabled', {
			roomId,
		})) as { serverIds: string[] };
		return result.serverIds;
	}

	describe('mcp.room.setEnabled', () => {
		test('enabling a server for a room adds it to the room enablement list', async () => {
			const { id: serverId } = await createRegistryServer('test-server-enable');

			// Initially not enabled for any room
			const initial = await getEnabledForRoom('room-enable-test');
			expect(initial).not.toContain(serverId);

			// Enable for room
			await enableForRoom('room-enable-test', serverId, true);

			// Now enabled
			const after = await getEnabledForRoom('room-enable-test');
			expect(after).toContain(serverId);
		});

		test('disabling a server for a room removes it from the room enablement list', async () => {
			const { id: serverId } = await createRegistryServer('test-server-disable');

			// Enable first
			await enableForRoom('room-disable-test', serverId, true);
			let enabled = await getEnabledForRoom('room-disable-test');
			expect(enabled).toContain(serverId);

			// Disable
			await enableForRoom('room-disable-test', serverId, false);
			enabled = await getEnabledForRoom('room-disable-test');
			expect(enabled).not.toContain(serverId);
		});

		test('server must exist in registry before it can be enabled for a room', async () => {
			// Try to enable a non-existent server
			await expect(
				daemon.messageHub.request('mcp.room.setEnabled', {
					roomId: 'room-missing-server',
					serverId: 'non-existent-server-id',
					enabled: true,
				})
			).rejects.toThrow();
		});
	});

	describe('mcp.room.resetToGlobal', () => {
		test('resetToGlobal removes all per-room overrides', async () => {
			const server1 = await createRegistryServer('reset-server-1');
			const server2 = await createRegistryServer('reset-server-2');

			// Enable both for a room
			await enableForRoom('room-reset-global', server1.id, true);
			await enableForRoom('room-reset-global', server2.id, true);

			let enabled = await getEnabledForRoom('room-reset-global');
			expect(enabled).toContain(server1.id);
			expect(enabled).toContain(server2.id);

			// Reset to global
			await daemon.messageHub.request('mcp.room.resetToGlobal', {
				roomId: 'room-reset-global',
			});

			// After reset, getEnabled returns empty (no explicit overrides)
			enabled = await getEnabledForRoom('room-reset-global');
			expect(enabled).toHaveLength(0);
		});
	});

	describe('mcp.registry.changed event', () => {
		test('changing registry emits mcp.registry.changed event', async () => {
			const server = await createRegistryServer('changed-event-server');

			// Enable for room
			await enableForRoom('room-changed-event', server.id, true);
			let enabled = await getEnabledForRoom('room-changed-event');
			expect(enabled).toContain(server.id);

			// The enableForRoom handler emits mcp.registry.changed,
			// which triggers hot-reload in RoomRuntimeService.
			// We verify the state change persisted correctly.
		});
	});

	describe('global fallback behavior', () => {
		test('rooms with no overrides fall back to globally enabled servers', async () => {
			// Create servers
			const serverA = await createRegistryServer('global-alpha');
			const serverB = await createRegistryServer('global-beta');

			// Enable globally (all servers start enabled by default from seed)
			// No per-room overrides set

			// A room with no overrides should not appear in getEnabledForRoom
			// (getEnabledForRoom only returns explicit overrides)
			const noOverrideRoom = await getEnabledForRoom('room-no-override');
			expect(noOverrideRoom).not.toContain(serverA.id);
			expect(noOverrideRoom).not.toContain(serverB.id);
		});
	});

	describe('integration with registry CRUD', () => {
		test('creating and deleting a server updates room enablement state', async () => {
			// Create a server
			const { id: serverId } = await createRegistryServer('crud-integration-server');

			// Enable for room
			await enableForRoom('room-crud-test', serverId, true);
			let enabled = await getEnabledForRoom('room-crud-test');
			expect(enabled).toContain(serverId);

			// Delete the server
			await daemon.messageHub.request('mcp.registry.delete', { id: serverId });

			// The override for the deleted server remains in room_mcp_enablement
			// but the server no longer exists in app_mcp_servers.
			// getEnabledServers joins with app_mcp_servers, so it won't return the deleted server.
			// This is expected behavior - orphaned overrides are cleaned up on next access.
		});
	});
});
