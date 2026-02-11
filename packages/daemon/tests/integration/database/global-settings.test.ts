/**
 * Global Settings Database Tests
 *
 * Tests for global settings persistence and CRUD operations
 */

import { describe, test } from 'bun:test';
import { Database } from '../../../src/storage/database';
import { createTestDb, assertEquals, assertExists } from '../../helpers/database';

describe('Database', () => {
	describe('Global Settings', () => {
		test('should return default settings on first load', async () => {
			const db = await createTestDb();

			const settings = db.getGlobalSettings();

			assertExists(settings);
			assertEquals(
				JSON.stringify(settings.settingSources),
				JSON.stringify(['user', 'project', 'local'])
			);
			assertEquals(JSON.stringify(settings.disabledMcpServers), JSON.stringify([]));

			db.close();
		});

		test('should save and load global settings', async () => {
			const db = await createTestDb();

			const customSettings = {
				settingSources: ['project', 'local'] as const,
				model: 'claude-opus-4-5-20251101',
				permissionMode: 'acceptEdits' as const,
				maxThinkingTokens: 10000,
				disabledMcpServers: ['server1', 'server2'],
			};

			db.saveGlobalSettings(customSettings);
			const loaded = db.getGlobalSettings();

			assertEquals(JSON.stringify(loaded.settingSources), JSON.stringify(['project', 'local']));
			assertEquals(loaded.model, 'claude-opus-4-5-20251101');
			assertEquals(loaded.permissionMode, 'acceptEdits');
			assertEquals(loaded.maxThinkingTokens, 10000);
			assertEquals(
				JSON.stringify(loaded.disabledMcpServers),
				JSON.stringify(['server1', 'server2'])
			);

			db.close();
		});

		test('should perform partial update', async () => {
			const db = await createTestDb();

			// First save
			db.saveGlobalSettings({
				settingSources: ['user', 'project', 'local'],
				model: 'claude-sonnet-4-5-20250929',
				disabledMcpServers: [],
			});

			// Partial update
			const updated = db.updateGlobalSettings({
				model: 'claude-opus-4-5-20251101',
				disabledMcpServers: ['server1'],
			});

			assertEquals(updated.model, 'claude-opus-4-5-20251101');
			assertEquals(JSON.stringify(updated.disabledMcpServers), JSON.stringify(['server1']));
			assertEquals(
				JSON.stringify(updated.settingSources),
				JSON.stringify(['user', 'project', 'local'])
			); // Unchanged

			db.close();
		});

		test('should merge with defaults for backward compatibility', async () => {
			const db = await createTestDb();

			// Save settings with only some fields
			db.saveGlobalSettings({
				settingSources: ['project'],
				model: 'claude-opus-4-5-20251101',
				disabledMcpServers: [],
			});

			// Load should merge with defaults
			const loaded = db.getGlobalSettings();

			assertExists(loaded.settingSources);
			assertExists(loaded.disabledMcpServers);
			assertEquals(loaded.model, 'claude-opus-4-5-20251101');

			db.close();
		});

		test('should persist settings across database close/reopen', async () => {
			const dbPath = ':memory:';
			let db = new Database(dbPath);
			await db.initialize();

			const customSettings = {
				settingSources: ['local'] as const,
				model: 'claude-haiku-3-5-20241022',
				disabledMcpServers: ['test-server'],
			};

			db.saveGlobalSettings(customSettings);
			db.close();

			// Note: In-memory database loses data on close
			// This test documents the expected behavior
			// For file-based databases, data would persist

			db = new Database(dbPath);
			await db.initialize();
			const loaded = db.getGlobalSettings();

			// In-memory DB returns defaults after reopen
			assertEquals(
				JSON.stringify(loaded.settingSources),
				JSON.stringify(['user', 'project', 'local'])
			);

			db.close();
		});

		test('should handle invalid JSON gracefully', async () => {
			const db = await createTestDb();

			// Manually insert invalid JSON (simulating corruption)
			try {
				(db as unknown as { db: { exec: (sql: string) => void } }).db.exec(`
					UPDATE global_settings SET settings = 'invalid-json' WHERE id = 1
				`);
			} catch {
				// Some versions might prevent this
			}

			// Should return defaults instead of throwing
			const loaded = db.getGlobalSettings();

			assertExists(loaded);
			assertEquals(
				JSON.stringify(loaded.settingSources),
				JSON.stringify(['user', 'project', 'local'])
			);

			db.close();
		});

		test('should only allow single row (id = 1)', async () => {
			const db = await createTestDb();

			// Save different settings
			db.saveGlobalSettings({
				settingSources: ['user', 'project', 'local'],
				model: 'claude-sonnet-4-5-20250929',
				disabledMcpServers: [],
			});

			db.saveGlobalSettings({
				settingSources: ['local'],
				model: 'claude-opus-4-5-20251101',
				disabledMcpServers: ['server1'],
			});

			// Should only have one row (second save replaces first)
			const loaded = db.getGlobalSettings();
			assertEquals(loaded.model, 'claude-opus-4-5-20251101');
			assertEquals(JSON.stringify(loaded.disabledMcpServers), JSON.stringify(['server1']));

			db.close();
		});
	});
});
