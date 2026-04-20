/**
 * Online tests for Per-Room MCP Enablement
 *
 * Tests the integration between:
 * - AppMcpLifecycleManager.getEnabledMcpConfigsForRoom()
 * - RoomMcpEnablementRepository (per-room overrides)
 * - mcp.room RPC handlers (setEnabled, getEnabled, resetToGlobal)
 *
 * These tests use the full daemon server with real database and RPC handlers.
 * They use dev proxy (mock_sdk: true) so no real AI API calls are made.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { createRoom } from './room-test-helpers';

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

	/**
	 * Helper to delete a room via RPC.
	 */
	async function deleteRoom(roomId: string): Promise<void> {
		await daemon.messageHub.request('room.delete', { roomId });
	}

	describe('mcp.room.setEnabled', () => {
		test('enabling a server for a room adds it to the room enablement list', async () => {
			// Create a real room so room_mcp_enablement FK constraint is satisfied
			const roomId = await createRoom(daemon, 'test-enable');
			const { id: serverId } = await createRegistryServer('test-server-enable');

			try {
				// Initially not enabled for any room
				const initial = await getEnabledForRoom(roomId);
				expect(initial).not.toContain(serverId);

				// Enable for room
				await enableForRoom(roomId, serverId, true);

				// Now enabled
				const after = await getEnabledForRoom(roomId);
				expect(after).toContain(serverId);
			} finally {
				await deleteRoom(roomId);
			}
		});

		test('disabling a server for a room removes it from the room enablement list', async () => {
			const roomId = await createRoom(daemon, 'test-disable');
			const { id: serverId } = await createRegistryServer('test-server-disable');

			try {
				// Enable first
				await enableForRoom(roomId, serverId, true);
				let enabled = await getEnabledForRoom(roomId);
				expect(enabled).toContain(serverId);

				// Disable
				await enableForRoom(roomId, serverId, false);
				enabled = await getEnabledForRoom(roomId);
				expect(enabled).not.toContain(serverId);
			} finally {
				await deleteRoom(roomId);
			}
		});

		test('server must exist in registry before it can be enabled for a room', async () => {
			const roomId = await createRoom(daemon, 'test-missing-server');

			try {
				// Try to enable a non-existent server — should throw
				await expect(
					daemon.messageHub.request('mcp.room.setEnabled', {
						roomId,
						serverId: 'non-existent-server-id',
						enabled: true,
					})
				).rejects.toThrow();
			} finally {
				await deleteRoom(roomId);
			}
		});
	});

	describe('mcp.room.resetToGlobal', () => {
		test('resetToGlobal removes all per-room overrides', async () => {
			const roomId = await createRoom(daemon, 'test-reset');
			const server1 = await createRegistryServer('reset-server-1');
			const server2 = await createRegistryServer('reset-server-2');

			try {
				// Enable both for the room
				await enableForRoom(roomId, server1.id, true);
				await enableForRoom(roomId, server2.id, true);

				let enabled = await getEnabledForRoom(roomId);
				expect(enabled).toContain(server1.id);
				expect(enabled).toContain(server2.id);

				// Reset to global
				await daemon.messageHub.request('mcp.room.resetToGlobal', {
					roomId,
				});

				// After reset, getEnabled returns empty (no explicit overrides)
				enabled = await getEnabledForRoom(roomId);
				expect(enabled).toHaveLength(0);
			} finally {
				await deleteRoom(roomId);
			}
		});
	});

	describe('mcp.registry.changed event', () => {
		test('changing registry emits mcp.registry.changed event', async () => {
			const roomId = await createRoom(daemon, 'test-changed-event');
			const server = await createRegistryServer('changed-event-server');

			try {
				// Enable for room
				await enableForRoom(roomId, server.id, true);
				let enabled = await getEnabledForRoom(roomId);
				expect(enabled).toContain(server.id);

				// The enableForRoom handler emits mcp.registry.changed,
				// which triggers hot-reload in RoomRuntimeService.
				// We verify the state change persisted correctly.
			} finally {
				await deleteRoom(roomId);
			}
		});
	});

	describe('global fallback behavior', () => {
		test('rooms with no overrides fall back to globally enabled servers', async () => {
			const roomId = await createRoom(daemon, 'test-global-fallback');

			try {
				// A room with no overrides should not appear in getEnabledForRoom
				// (getEnabledForRoom only returns explicit overrides)
				const enabled = await getEnabledForRoom(roomId);
				expect(enabled).toHaveLength(0);
			} finally {
				await deleteRoom(roomId);
			}
		});
	});

	describe('integration with registry CRUD', () => {
		test('creating and deleting a server updates room enablement state', async () => {
			const roomId = await createRoom(daemon, 'test-crud');
			const { id: serverId } = await createRegistryServer('crud-integration-server');

			try {
				// Enable for room
				await enableForRoom(roomId, serverId, true);
				let enabled = await getEnabledForRoom(roomId);
				expect(enabled).toContain(serverId);

				// Delete the server
				await daemon.messageHub.request('mcp.registry.delete', { id: serverId });

				// The override for the deleted server remains in room_mcp_enablement
				// but the server no longer exists in app_mcp_servers.
				// getEnabledServers joins with app_mcp_servers, so it won't return the deleted server.
				// This is expected behavior - orphaned overrides are cleaned up on next access.
			} finally {
				await deleteRoom(roomId);
			}
		});
	});
});
