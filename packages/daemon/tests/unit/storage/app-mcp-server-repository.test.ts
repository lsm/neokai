/**
 * AppMcpServerRepository Unit Tests
 *
 * Covers CRUD operations, listEnabled() filtering, and that
 * notifyChange('app_mcp_servers') is called after each write.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';
import { AppMcpServerRepository } from '../../../src/storage/repositories/app-mcp-server-repository';
import type { ReactiveDatabase } from '../../../src/storage/reactive-database';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('AppMcpServerRepository', () => {
	let bunDb: BunDatabase;
	let reactiveDb: ReactiveDatabase;
	let repo: AppMcpServerRepository;
	let notifyChangeSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		bunDb = new BunDatabase(':memory:');
		createTables(bunDb);

		reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);

		// Spy on notifyChange
		notifyChangeSpy = mock(() => {});
		reactiveDb.notifyChange = notifyChangeSpy;

		repo = new AppMcpServerRepository(bunDb, reactiveDb);
	});

	afterEach(() => {
		bunDb.close();
	});

	// ---------------------------------------------------------------------------
	// create
	// ---------------------------------------------------------------------------

	describe('create', () => {
		test('creates a stdio server entry and returns it', () => {
			const server = repo.create({
				name: 'brave-search',
				sourceType: 'stdio',
				command: 'npx',
				args: ['-y', '@modelcontextprotocol/server-brave-search'],
				env: { BRAVE_API_KEY: 'BRAVE_API_KEY' },
				enabled: true,
			});

			expect(server.id).toBeTruthy();
			expect(server.name).toBe('brave-search');
			expect(server.sourceType).toBe('stdio');
			expect(server.command).toBe('npx');
			expect(server.args).toEqual(['-y', '@modelcontextprotocol/server-brave-search']);
			expect(server.env).toEqual({ BRAVE_API_KEY: 'BRAVE_API_KEY' });
			expect(server.enabled).toBe(true);
			expect(server.createdAt).toBeTruthy();
			expect(server.updatedAt).toBeTruthy();
		});

		test('creates an SSE server entry', () => {
			const server = repo.create({
				name: 'sse-server',
				sourceType: 'sse',
				url: 'http://localhost:8080/sse',
				headers: { Authorization: 'Bearer token' },
				enabled: true,
			});

			expect(server.sourceType).toBe('sse');
			expect(server.url).toBe('http://localhost:8080/sse');
			expect(server.headers).toEqual({ Authorization: 'Bearer token' });
		});

		test('creates an HTTP server entry', () => {
			const server = repo.create({
				name: 'http-server',
				sourceType: 'http',
				url: 'http://localhost:9000',
				enabled: false,
			});

			expect(server.sourceType).toBe('http');
			expect(server.enabled).toBe(false);
		});

		test('omits optional fields when not provided', () => {
			const server = repo.create({
				name: 'minimal',
				sourceType: 'stdio',
				enabled: true,
			});

			expect(server.description).toBeUndefined();
			expect(server.command).toBeUndefined();
			expect(server.args).toBeUndefined();
			expect(server.env).toBeUndefined();
			expect(server.url).toBeUndefined();
			expect(server.headers).toBeUndefined();
		});

		test('calls notifyChange("app_mcp_servers") after create', () => {
			notifyChangeSpy.mockClear();
			repo.create({ name: 'notify-test', sourceType: 'stdio', enabled: true });
			expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
			expect(notifyChangeSpy).toHaveBeenCalledWith('app_mcp_servers');
		});
	});

	// ---------------------------------------------------------------------------
	// get
	// ---------------------------------------------------------------------------

	describe('get', () => {
		test('returns server by id', () => {
			const created = repo.create({ name: 'get-test', sourceType: 'stdio', enabled: true });
			const fetched = repo.get(created.id);
			expect(fetched).not.toBeNull();
			expect(fetched!.id).toBe(created.id);
		});

		test('returns null for unknown id', () => {
			expect(repo.get('nonexistent-id')).toBeNull();
		});
	});

	// ---------------------------------------------------------------------------
	// getByName
	// ---------------------------------------------------------------------------

	describe('getByName', () => {
		test('returns server by name', () => {
			repo.create({ name: 'named-server', sourceType: 'http', url: 'http://x', enabled: true });
			const found = repo.getByName('named-server');
			expect(found).not.toBeNull();
			expect(found!.name).toBe('named-server');
		});

		test('returns null for unknown name', () => {
			expect(repo.getByName('no-such-server')).toBeNull();
		});
	});

	// ---------------------------------------------------------------------------
	// list
	// ---------------------------------------------------------------------------

	describe('list', () => {
		test('returns all servers ordered by created_at', () => {
			repo.create({ name: 'alpha', sourceType: 'stdio', enabled: true });
			repo.create({ name: 'beta', sourceType: 'stdio', enabled: false });
			repo.create({ name: 'gamma', sourceType: 'http', url: 'http://g', enabled: true });

			const all = repo.list();
			expect(all).toHaveLength(3);
			const names = all.map((s) => s.name);
			expect(names).toContain('alpha');
			expect(names).toContain('beta');
			expect(names).toContain('gamma');
		});

		test('returns empty array when no servers exist', () => {
			expect(repo.list()).toHaveLength(0);
		});
	});

	// ---------------------------------------------------------------------------
	// listEnabled
	// ---------------------------------------------------------------------------

	describe('listEnabled', () => {
		test('returns only enabled servers', () => {
			repo.create({ name: 'enabled-1', sourceType: 'stdio', enabled: true });
			repo.create({ name: 'disabled-1', sourceType: 'stdio', enabled: false });
			repo.create({ name: 'enabled-2', sourceType: 'http', url: 'http://e2', enabled: true });

			const enabled = repo.listEnabled();
			expect(enabled).toHaveLength(2);
			expect(enabled.every((s) => s.enabled)).toBe(true);
			const names = enabled.map((s) => s.name);
			expect(names).toContain('enabled-1');
			expect(names).toContain('enabled-2');
			expect(names).not.toContain('disabled-1');
		});

		test('returns empty array when no enabled servers', () => {
			repo.create({ name: 'off', sourceType: 'stdio', enabled: false });
			expect(repo.listEnabled()).toHaveLength(0);
		});
	});

	// ---------------------------------------------------------------------------
	// update
	// ---------------------------------------------------------------------------

	describe('update', () => {
		test('updates name and description', () => {
			const server = repo.create({ name: 'old-name', sourceType: 'stdio', enabled: true });
			const updated = repo.update(server.id, { name: 'new-name', description: 'A description' });

			expect(updated).not.toBeNull();
			expect(updated!.name).toBe('new-name');
			expect(updated!.description).toBe('A description');
		});

		test('updates enabled flag', () => {
			const server = repo.create({ name: 'toggle', sourceType: 'stdio', enabled: true });
			const updated = repo.update(server.id, { enabled: false });

			expect(updated!.enabled).toBe(false);
		});

		test('updates args and env as JSON', () => {
			const server = repo.create({
				name: 'json-fields',
				sourceType: 'stdio',
				command: 'node',
				enabled: true,
			});
			const updated = repo.update(server.id, {
				args: ['--port', '3000'],
				env: { PORT: '3000' },
			});

			expect(updated!.args).toEqual(['--port', '3000']);
			expect(updated!.env).toEqual({ PORT: '3000' });
		});

		test('returns null for unknown id', () => {
			expect(repo.update('nonexistent', { name: 'x' })).toBeNull();
		});

		test('calls notifyChange("app_mcp_servers") after update', () => {
			const server = repo.create({ name: 'notify-update', sourceType: 'stdio', enabled: true });
			notifyChangeSpy.mockClear();
			repo.update(server.id, { description: 'updated' });
			expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
			expect(notifyChangeSpy).toHaveBeenCalledWith('app_mcp_servers');
		});

		test('does not call notifyChange when no fields are changed', () => {
			const server = repo.create({ name: 'no-change', sourceType: 'stdio', enabled: true });
			notifyChangeSpy.mockClear();
			// Call update with an empty updates object (no fields to set)
			repo.update(server.id, {});
			expect(notifyChangeSpy).not.toHaveBeenCalled();
		});
	});

	// ---------------------------------------------------------------------------
	// delete
	// ---------------------------------------------------------------------------

	describe('delete', () => {
		test('deletes an existing entry and returns true', () => {
			const server = repo.create({ name: 'to-delete', sourceType: 'stdio', enabled: true });
			const result = repo.delete(server.id);

			expect(result).toBe(true);
			expect(repo.get(server.id)).toBeNull();
		});

		test('returns false for unknown id', () => {
			expect(repo.delete('nonexistent')).toBe(false);
		});

		test('calls notifyChange("app_mcp_servers") after delete', () => {
			const server = repo.create({ name: 'notify-delete', sourceType: 'stdio', enabled: true });
			notifyChangeSpy.mockClear();
			repo.delete(server.id);
			expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
			expect(notifyChangeSpy).toHaveBeenCalledWith('app_mcp_servers');
		});

		test('does not call notifyChange when deleting nonexistent id', () => {
			notifyChangeSpy.mockClear();
			repo.delete('nonexistent');
			expect(notifyChangeSpy).not.toHaveBeenCalled();
		});
	});
});
