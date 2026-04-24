/**
 * RoomMcpEnablementRepository Unit Tests
 *
 * Covers setEnabled, getEnabledServerIds, getEnabledServers, resetToGlobal,
 * getOverride, notifyChange calls, and behavior with missing servers.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../../src/storage/schema';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { RoomMcpEnablementRepository } from '../../../../src/storage/repositories/room-mcp-enablement-repository';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('RoomMcpEnablementRepository', () => {
	let bunDb: BunDatabase;
	let reactiveDb: ReactiveDatabase;
	let repo: RoomMcpEnablementRepository;
	let appMcpRepo: AppMcpServerRepository;
	let notifyChangeSpy: ReturnType<typeof mock>;

	const ROOM_A = 'room-aaa';
	const ROOM_B = 'room-bbb';

	function insertRoom(id: string): void {
		const now = Date.now();
		bunDb
			.prepare(`INSERT INTO rooms (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
			.run(id, id, now, now);
	}

	beforeEach(() => {
		bunDb = new BunDatabase(':memory:');
		// Enable foreign keys for CASCADE tests
		bunDb.exec('PRAGMA foreign_keys = ON');
		createTables(bunDb);

		reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
		notifyChangeSpy = mock(() => {});
		reactiveDb.notifyChange = notifyChangeSpy;

		appMcpRepo = new AppMcpServerRepository(bunDb, reactiveDb);
		repo = new RoomMcpEnablementRepository(bunDb, reactiveDb);

		// Insert rooms required by the FK constraint
		insertRoom(ROOM_A);
		insertRoom(ROOM_B);
	});

	afterEach(() => {
		bunDb.close();
	});

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	function createServer(name: string) {
		return appMcpRepo.create({ name, sourceType: 'stdio', command: 'npx' });
	}

	// ---------------------------------------------------------------------------
	// setEnabled
	// ---------------------------------------------------------------------------

	describe('setEnabled', () => {
		test('inserts an enabled override', () => {
			const srv = createServer('test-search');
			repo.setEnabled(ROOM_A, srv.id, true);

			const ids = repo.getEnabledServerIds(ROOM_A);
			expect(ids).toContain(srv.id);
		});

		test('inserts a disabled override', () => {
			const srv = createServer('fetch');
			repo.setEnabled(ROOM_A, srv.id, false);

			const ids = repo.getEnabledServerIds(ROOM_A);
			expect(ids).not.toContain(srv.id);
		});

		test('upserts — flipping from disabled to enabled', () => {
			const srv = createServer('flipper');
			repo.setEnabled(ROOM_A, srv.id, false);
			repo.setEnabled(ROOM_A, srv.id, true);

			const ids = repo.getEnabledServerIds(ROOM_A);
			expect(ids).toContain(srv.id);
		});

		test('calls notifyChange after each write', () => {
			const srv = createServer('notifier');
			notifyChangeSpy.mockClear();
			repo.setEnabled(ROOM_A, srv.id, true);
			expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
			expect(notifyChangeSpy).toHaveBeenCalledWith('room_mcp_enablement');
		});

		test('per-room isolation — enabling in ROOM_A does not affect ROOM_B', () => {
			const srv = createServer('isolated');
			repo.setEnabled(ROOM_A, srv.id, true);

			expect(repo.getEnabledServerIds(ROOM_A)).toContain(srv.id);
			expect(repo.getEnabledServerIds(ROOM_B)).not.toContain(srv.id);
		});
	});

	// ---------------------------------------------------------------------------
	// getEnabledServerIds
	// ---------------------------------------------------------------------------

	describe('getEnabledServerIds', () => {
		test('returns empty array when no overrides exist', () => {
			expect(repo.getEnabledServerIds(ROOM_A)).toEqual([]);
		});

		test('returns only enabled server IDs, not disabled ones', () => {
			const srvOn = createServer('on');
			const srvOff = createServer('off');
			repo.setEnabled(ROOM_A, srvOn.id, true);
			repo.setEnabled(ROOM_A, srvOff.id, false);

			const ids = repo.getEnabledServerIds(ROOM_A);
			expect(ids).toContain(srvOn.id);
			expect(ids).not.toContain(srvOff.id);
		});

		test('returns multiple enabled IDs', () => {
			const srv1 = createServer('srv1');
			const srv2 = createServer('srv2');
			const srv3 = createServer('srv3');
			repo.setEnabled(ROOM_A, srv1.id, true);
			repo.setEnabled(ROOM_A, srv2.id, true);
			repo.setEnabled(ROOM_A, srv3.id, false);

			const ids = repo.getEnabledServerIds(ROOM_A);
			expect(ids).toHaveLength(2);
			expect(ids).toContain(srv1.id);
			expect(ids).toContain(srv2.id);
		});
	});

	// ---------------------------------------------------------------------------
	// getEnabledServers
	// ---------------------------------------------------------------------------

	describe('getEnabledServers', () => {
		test('returns full AppMcpServer objects for enabled servers', () => {
			const srv = appMcpRepo.create({
				name: 'full-server',
				sourceType: 'stdio',
				command: 'npx',
				args: ['-y', '@mcp/test'],
				description: 'A test server',
			});
			repo.setEnabled(ROOM_A, srv.id, true);

			const servers = repo.getEnabledServers(ROOM_A);
			expect(servers).toHaveLength(1);
			expect(servers[0].name).toBe('full-server');
			expect(servers[0].sourceType).toBe('stdio');
			expect(servers[0].command).toBe('npx');
			expect(servers[0].args).toEqual(['-y', '@mcp/test']);
			expect(servers[0].description).toBe('A test server');
			expect(servers[0].enabled).toBe(true);
		});

		test('does not return disabled servers', () => {
			const srv = createServer('disabled-server');
			repo.setEnabled(ROOM_A, srv.id, false);

			const servers = repo.getEnabledServers(ROOM_A);
			expect(servers).toHaveLength(0);
		});

		test('returns empty array when no overrides exist', () => {
			expect(repo.getEnabledServers(ROOM_A)).toEqual([]);
		});
	});

	// ---------------------------------------------------------------------------
	// resetToGlobal
	// ---------------------------------------------------------------------------

	describe('resetToGlobal', () => {
		test('removes all overrides for a room', () => {
			const srv1 = createServer('reset1');
			const srv2 = createServer('reset2');
			repo.setEnabled(ROOM_A, srv1.id, true);
			repo.setEnabled(ROOM_A, srv2.id, false);

			repo.resetToGlobal(ROOM_A);

			expect(repo.getEnabledServerIds(ROOM_A)).toEqual([]);
		});

		test('does not affect other rooms', () => {
			const srv = createServer('cross-room');
			repo.setEnabled(ROOM_A, srv.id, true);
			repo.setEnabled(ROOM_B, srv.id, true);

			repo.resetToGlobal(ROOM_A);

			expect(repo.getEnabledServerIds(ROOM_A)).toEqual([]);
			expect(repo.getEnabledServerIds(ROOM_B)).toContain(srv.id);
		});

		test('calls notifyChange', () => {
			const srv = createServer('notify-reset');
			repo.setEnabled(ROOM_A, srv.id, true);
			notifyChangeSpy.mockClear();

			repo.resetToGlobal(ROOM_A);
			expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
			expect(notifyChangeSpy).toHaveBeenCalledWith('room_mcp_enablement');
		});

		test('no-op when room has no overrides', () => {
			expect(() => repo.resetToGlobal('nonexistent-room')).not.toThrow();
		});
	});

	// ---------------------------------------------------------------------------
	// getOverride
	// ---------------------------------------------------------------------------

	describe('getOverride', () => {
		test('returns null when no override exists', () => {
			const srv = createServer('no-override');
			expect(repo.getOverride(ROOM_A, srv.id)).toBeNull();
		});

		test('returns enabled:true for an enabled override', () => {
			const srv = createServer('get-override-on');
			repo.setEnabled(ROOM_A, srv.id, true);
			expect(repo.getOverride(ROOM_A, srv.id)).toEqual({ enabled: true });
		});

		test('returns enabled:false for a disabled override', () => {
			const srv = createServer('get-override-off');
			repo.setEnabled(ROOM_A, srv.id, false);
			expect(repo.getOverride(ROOM_A, srv.id)).toEqual({ enabled: false });
		});
	});
});
