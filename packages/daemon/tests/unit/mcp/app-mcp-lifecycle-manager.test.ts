/**
 * AppMcpLifecycleManager Unit Tests
 *
 * Covers:
 * - Conversion of stdio / sse / http entries to the correct SDK config shape.
 * - Disabled entries are excluded from getEnabledMcpConfigs().
 * - validateEntry() catches missing required fields.
 * - getStartupErrors() returns invalid entries with descriptive messages.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';
import { AppMcpServerRepository } from '../../../src/storage/repositories/app-mcp-server-repository';
import { AppMcpLifecycleManager } from '../../../src/lib/mcp';
import type { ReactiveDatabase } from '../../../src/storage/reactive-database';
import type { Database } from '../../../src/storage/database';

// ---------------------------------------------------------------------------
// Minimal Database facade stub
// ---------------------------------------------------------------------------

function createTestDb(): { bunDb: BunDatabase; reactiveDb: ReactiveDatabase; db: Database } {
	const bunDb = new BunDatabase(':memory:');
	createTables(bunDb);
	const reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
	const repo = new AppMcpServerRepository(bunDb, reactiveDb);

	// Build a minimal Database facade that exposes appMcpServers
	const db = {
		appMcpServers: repo,
	} as unknown as Database;

	return { bunDb, reactiveDb, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppMcpLifecycleManager', () => {
	let bunDb: BunDatabase;
	let db: Database;
	let manager: AppMcpLifecycleManager;
	let repo: AppMcpServerRepository;

	beforeEach(() => {
		const setup = createTestDb();
		bunDb = setup.bunDb;
		db = setup.db;
		repo = db.appMcpServers as unknown as AppMcpServerRepository;
		manager = new AppMcpLifecycleManager(db);
	});

	afterEach(() => {
		bunDb.close();
	});

	// -------------------------------------------------------------------------
	// getEnabledMcpConfigs — stdio conversion
	// -------------------------------------------------------------------------

	describe('getEnabledMcpConfigs — stdio', () => {
		test('converts a stdio entry to McpStdioServerConfig', () => {
			repo.create({
				name: 'brave-search',
				sourceType: 'stdio',
				command: 'npx',
				args: ['-y', '@modelcontextprotocol/server-brave-search'],
				env: { BRAVE_API_KEY: 'BRAVE_API_KEY' },
			});

			const configs = manager.getEnabledMcpConfigs();

			expect(configs['brave-search']).toBeDefined();
			expect(configs['brave-search'].type).toBe('stdio');

			const stdioConfig = configs['brave-search'] as {
				type: string;
				command: string;
				args: string[];
				env: Record<string, string>;
			};
			expect(stdioConfig.command).toBe('npx');
			expect(stdioConfig.args).toEqual(['-y', '@modelcontextprotocol/server-brave-search']);
			expect(stdioConfig.env).toEqual({ BRAVE_API_KEY: 'BRAVE_API_KEY' });
		});

		test('stdio entry without optional args/env omits those fields', () => {
			repo.create({
				name: 'minimal-stdio',
				sourceType: 'stdio',
				command: 'my-server',
			});

			const configs = manager.getEnabledMcpConfigs();
			const config = configs['minimal-stdio'] as {
				command: string;
				args?: string[];
				env?: Record<string, string>;
			};

			expect(config.command).toBe('my-server');
			expect(config.args).toBeUndefined();
			expect(config.env).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// getEnabledMcpConfigs — sse conversion
	// -------------------------------------------------------------------------

	describe('getEnabledMcpConfigs — sse', () => {
		test('converts an sse entry to McpSSEServerConfig', () => {
			repo.create({
				name: 'remote-sse',
				sourceType: 'sse',
				url: 'https://example.com/sse',
				headers: { Authorization: 'Bearer token' },
			});

			const configs = manager.getEnabledMcpConfigs();

			expect(configs['remote-sse']).toBeDefined();
			expect(configs['remote-sse'].type).toBe('sse');

			const sseConfig = configs['remote-sse'] as {
				type: string;
				url: string;
				headers: Record<string, string>;
			};
			expect(sseConfig.url).toBe('https://example.com/sse');
			expect(sseConfig.headers).toEqual({ Authorization: 'Bearer token' });
		});

		test('sse entry without headers omits the headers field', () => {
			repo.create({
				name: 'plain-sse',
				sourceType: 'sse',
				url: 'https://example.com/sse',
			});

			const configs = manager.getEnabledMcpConfigs();
			const config = configs['plain-sse'] as { headers?: Record<string, string> };

			expect(config.headers).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// getEnabledMcpConfigs — http conversion
	// -------------------------------------------------------------------------

	describe('getEnabledMcpConfigs — http', () => {
		test('converts an http entry to McpHttpServerConfig', () => {
			repo.create({
				name: 'remote-http',
				sourceType: 'http',
				url: 'https://example.com/mcp',
				headers: { 'X-API-Key': 'secret' },
			});

			const configs = manager.getEnabledMcpConfigs();

			expect(configs['remote-http']).toBeDefined();
			expect(configs['remote-http'].type).toBe('http');

			const httpConfig = configs['remote-http'] as {
				type: string;
				url: string;
				headers: Record<string, string>;
			};
			expect(httpConfig.url).toBe('https://example.com/mcp');
			expect(httpConfig.headers).toEqual({ 'X-API-Key': 'secret' });
		});
	});

	// -------------------------------------------------------------------------
	// Disabled entries excluded
	// -------------------------------------------------------------------------

	describe('disabled entries', () => {
		test('disabled entries are excluded from getEnabledMcpConfigs()', () => {
			repo.create({
				name: 'enabled-server',
				sourceType: 'stdio',
				command: 'my-server',
				enabled: true,
			});
			repo.create({
				name: 'disabled-server',
				sourceType: 'stdio',
				command: 'another-server',
				enabled: false,
			});

			const configs = manager.getEnabledMcpConfigs();

			expect(configs['enabled-server']).toBeDefined();
			expect(configs['disabled-server']).toBeUndefined();
		});

		test('returns empty record when all entries are disabled', () => {
			repo.create({
				name: 'disabled-server',
				sourceType: 'stdio',
				command: 'my-server',
				enabled: false,
			});

			const configs = manager.getEnabledMcpConfigs();
			expect(Object.keys(configs)).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// validateEntry
	// -------------------------------------------------------------------------

	describe('validateEntry', () => {
		test('valid stdio entry passes validation', () => {
			const result = manager.validateEntry({
				id: 'test-id',
				name: 'test',
				sourceType: 'stdio',
				command: 'npx',
				enabled: true,
			});

			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		test('stdio entry missing command fails validation', () => {
			const result = manager.validateEntry({
				id: 'test-id',
				name: 'broken-stdio',
				sourceType: 'stdio',
				enabled: true,
			});

			expect(result.valid).toBe(false);
			expect(result.error).toContain('command');
			expect(result.error).toContain('broken-stdio');
		});

		test('stdio entry with empty command fails validation', () => {
			const result = manager.validateEntry({
				id: 'test-id',
				name: 'empty-cmd',
				sourceType: 'stdio',
				command: '   ',
				enabled: true,
			});

			expect(result.valid).toBe(false);
			expect(result.error).toContain('command');
		});

		test('valid sse entry passes validation', () => {
			const result = manager.validateEntry({
				id: 'test-id',
				name: 'test-sse',
				sourceType: 'sse',
				url: 'https://example.com/sse',
				enabled: true,
			});

			expect(result.valid).toBe(true);
		});

		test('sse entry missing url fails validation', () => {
			const result = manager.validateEntry({
				id: 'test-id',
				name: 'broken-sse',
				sourceType: 'sse',
				enabled: true,
			});

			expect(result.valid).toBe(false);
			expect(result.error).toContain('url');
			expect(result.error).toContain('broken-sse');
		});

		test('valid http entry passes validation', () => {
			const result = manager.validateEntry({
				id: 'test-id',
				name: 'test-http',
				sourceType: 'http',
				url: 'https://example.com/mcp',
				enabled: true,
			});

			expect(result.valid).toBe(true);
		});

		test('http entry missing url fails validation', () => {
			const result = manager.validateEntry({
				id: 'test-id',
				name: 'broken-http',
				sourceType: 'http',
				enabled: true,
			});

			expect(result.valid).toBe(false);
			expect(result.error).toContain('url');
			expect(result.error).toContain('broken-http');
		});
	});

	// -------------------------------------------------------------------------
	// getStartupErrors
	// -------------------------------------------------------------------------

	describe('getStartupErrors', () => {
		test('returns empty array when all entries are valid', () => {
			repo.create({
				name: 'valid-stdio',
				sourceType: 'stdio',
				command: 'my-server',
			});
			repo.create({
				name: 'valid-sse',
				sourceType: 'sse',
				url: 'https://example.com/sse',
			});

			const errors = manager.getStartupErrors();
			expect(errors).toHaveLength(0);
		});

		test('returns invalid entries with descriptive error messages', () => {
			repo.create({
				name: 'broken-stdio',
				sourceType: 'stdio',
				// no command
			});
			repo.create({
				name: 'broken-sse',
				sourceType: 'sse',
				// no url
			});
			repo.create({
				name: 'valid-http',
				sourceType: 'http',
				url: 'https://example.com/mcp',
			});

			const errors = manager.getStartupErrors();

			expect(errors).toHaveLength(2);

			const names = errors.map((e) => e.name);
			expect(names).toContain('broken-stdio');
			expect(names).toContain('broken-sse');

			const stdioError = errors.find((e) => e.name === 'broken-stdio')!;
			expect(stdioError.error).toContain('command');
			expect(stdioError.serverId).toBeTruthy();

			const sseError = errors.find((e) => e.name === 'broken-sse')!;
			expect(sseError.error).toContain('url');
			expect(sseError.serverId).toBeTruthy();
		});

		test('includes disabled invalid entries (not just enabled ones)', () => {
			repo.create({
				name: 'disabled-broken',
				sourceType: 'stdio',
				enabled: false,
				// no command
			});

			const errors = manager.getStartupErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0].name).toBe('disabled-broken');
		});

		test('includes serverId matching the registry entry id', () => {
			const server = repo.create({
				name: 'broken-server',
				sourceType: 'http',
				// no url
			});

			const errors = manager.getStartupErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0].serverId).toBe(server.id);
		});
	});

	// -------------------------------------------------------------------------
	// getEnabledMcpConfigsForRoom (stub)
	// -------------------------------------------------------------------------

	describe('getEnabledMcpConfigsForRoom', () => {
		test('falls back to global enabled configs (stub behavior)', () => {
			repo.create({
				name: 'global-server',
				sourceType: 'stdio',
				command: 'my-server',
				enabled: true,
			});

			const globalConfigs = manager.getEnabledMcpConfigs();
			const roomConfigs = manager.getEnabledMcpConfigsForRoom('room-123');

			expect(roomConfigs).toEqual(globalConfigs);
		});
	});
});
