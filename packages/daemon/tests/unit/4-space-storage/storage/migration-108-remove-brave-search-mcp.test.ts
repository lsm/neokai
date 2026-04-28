import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration108 } from '../../../../src/storage/schema/migrations';
import { createTables } from '../../../../src/storage/schema';

describe('migration 108 removes Brave Search MCP data', () => {
	test('deletes legacy server, skill, and overrides', () => {
		const db = new BunDatabase(':memory:');
		try {
			createTables(db);

			db.prepare(
				`INSERT INTO app_mcp_servers
					(id, name, description, source_type, command, args, env, enabled, source, created_at, updated_at)
				 VALUES (?, ?, ?, 'stdio', 'npx', ?, ?, 0, 'user', 1, 1)`
			).run(
				'legacy-server',
				'brave-search',
				'Web search via Brave Search API',
				JSON.stringify(['-y', '@modelcontextprotocol/server-brave-search']),
				JSON.stringify({ BRAVE_API_KEY: 'BRAVE_API_KEY' })
			);
			db.prepare(
				`INSERT INTO app_mcp_servers
					(id, name, description, source_type, command, args, env, enabled, source, created_at, updated_at)
				 VALUES (?, 'custom-search', 'Unrelated search MCP', 'stdio', 'npx', ?, '{}', 1, 'user', 1, 1)`
			).run('kept-server', JSON.stringify(['-y', 'custom-search-mcp']));
			db.prepare(
				`INSERT INTO skills
					(id, name, display_name, description, source_type, config, enabled, built_in, validation_status, created_at)
				 VALUES (?, ?, ?, ?, 'mcp_server', ?, 0, 1, 'valid', 1)`
			).run(
				'legacy-skill',
				'web-search-mcp',
				'Web Search (MCP)',
				'Web search capability via Brave Search MCP',
				JSON.stringify({ type: 'mcp_server', appMcpServerId: 'legacy-server' })
			);
			db.prepare(
				`INSERT INTO skills
					(id, name, display_name, description, source_type, config, enabled, built_in, validation_status, created_at)
				 VALUES ('kept-skill', 'custom-search-skill', 'Custom Search', 'Unrelated', 'mcp_server', ?, 1, 0, 'valid', 1)`
			).run(JSON.stringify({ type: 'mcp_server', appMcpServerId: 'kept-server' }));
			db.prepare(
				`INSERT INTO mcp_enablement (server_id, scope_type, scope_id, enabled)
				 VALUES ('legacy-server', 'space', 'space-1', 0)`
			).run();
			db.prepare(
				`INSERT INTO room_mcp_enablement (room_id, server_id, enabled)
				 VALUES ('room-1', 'legacy-server', 0)`
			).run();
			db.prepare(
				`INSERT INTO room_skill_overrides (skill_id, room_id, enabled)
				 VALUES ('legacy-skill', 'room-1', 0)`
			).run();

			runMigration108(db);

			expect(
				db.prepare(`SELECT 1 FROM app_mcp_servers WHERE id = 'legacy-server'`).get()
			).toBeNull();
			expect(db.prepare(`SELECT 1 FROM skills WHERE id = 'legacy-skill'`).get()).toBeNull();
			expect(
				db.prepare(`SELECT 1 FROM mcp_enablement WHERE server_id = 'legacy-server'`).get()
			).toBeNull();
			expect(
				db.prepare(`SELECT 1 FROM room_mcp_enablement WHERE server_id = 'legacy-server'`).get()
			).toBeNull();
			expect(
				db.prepare(`SELECT 1 FROM room_skill_overrides WHERE skill_id = 'legacy-skill'`).get()
			).toBeNull();
			expect(
				db.prepare(`SELECT 1 FROM app_mcp_servers WHERE id = 'kept-server'`).get()
			).not.toBeNull();
			expect(db.prepare(`SELECT 1 FROM skills WHERE id = 'kept-skill'`).get()).not.toBeNull();
		} finally {
			db.close();
		}
	});

	test('prunes legacy names from persisted settings and session config', () => {
		const db = new BunDatabase(':memory:');
		try {
			createTables(db);
			db.prepare(`UPDATE global_settings SET settings = ? WHERE id = 1`).run(
				JSON.stringify({
					disabledMcpServers: ['brave-search', 'custom-search'],
					enabledMcpServers: ['web-search-mcp', 'custom-search'],
				})
			);
			db.prepare(
				`INSERT INTO sessions
					(id, title, workspace_path, created_at, last_active_at, status, config, metadata)
				 VALUES ('session-1', 'Test', '/tmp', 'now', 'now', 'active', ?, '{}')`
			).run(
				JSON.stringify({
					tools: { disabledMcpServers: ['brave-search', 'custom-search'] },
					disabledMcpServers: ['web-search-mcp', 'custom-search'],
				})
			);

			runMigration108(db);

			const settings = JSON.parse(
				(
					db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as {
						settings: string;
					}
				).settings
			) as { disabledMcpServers: string[]; enabledMcpServers: string[] };
			const sessionConfig = JSON.parse(
				(
					db.prepare(`SELECT config FROM sessions WHERE id = 'session-1'`).get() as {
						config: string;
					}
				).config
			) as {
				tools: { disabledMcpServers: string[] };
				disabledMcpServers: string[];
			};

			expect(settings.disabledMcpServers).toEqual(['custom-search']);
			expect(settings.enabledMcpServers).toEqual(['custom-search']);
			expect(sessionConfig.tools.disabledMcpServers).toEqual(['custom-search']);
			expect(sessionConfig.disabledMcpServers).toEqual(['custom-search']);
		} finally {
			db.close();
		}
	});
});
