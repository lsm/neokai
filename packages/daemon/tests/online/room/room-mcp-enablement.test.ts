/**
 * Online compatibility checks for legacy Room MCP enablement.
 *
 * Room MCP enablement rows remain in the database for old data compatibility,
 * but the historical public mcp.room.* RPC surface is no longer registered.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';

describe('Room MCP Enablement — Online legacy compatibility', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(async () => {
		if (!daemon) return;
		daemon.kill('SIGTERM');
		await daemon.waitForExit();
	}, 15000);

	describe('mcp.room legacy RPC surface', () => {
		test('does not expose historical room MCP handlers', async () => {
			await expect(
				daemon.messageHub.request('mcp.room.getEnabled', { roomId: 'legacy-room' })
			).rejects.toThrow();
			await expect(
				daemon.messageHub.request('mcp.room.setEnabled', {
					roomId: 'legacy-room',
					serverId: 'legacy-server',
					enabled: true,
				})
			).rejects.toThrow();
			await expect(
				daemon.messageHub.request('mcp.room.resetToGlobal', { roomId: 'legacy-room' })
			).rejects.toThrow();
		});
	});
});
