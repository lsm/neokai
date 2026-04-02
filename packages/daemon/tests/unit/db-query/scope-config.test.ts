import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables, runMigrations } from '../../../src/storage/schema/index.ts';
import {
	buildScopeFilter,
	getAccessibleTableNames,
	getBlacklistedColumns,
	getExcludedTableNames,
	getScopeConfig,
	getScopeForSession,
	type ScopeTableConfig,
} from '@/lib/db-query/scope-config';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tableNames(configs: ScopeTableConfig[]): string[] {
	return configs.map((c) => c.tableName);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('scope-config', () => {
	// ── getScopeConfig ────────────────────────────────────────────────────────

	describe('getScopeConfig', () => {
		it('global scope returns the correct set of tables', () => {
			const config = getScopeConfig('global');
			const names = tableNames(config);
			expect(names).toEqual([
				'sessions',
				'rooms',
				'spaces',
				'app_mcp_servers',
				'skills',
				'inbox_items',
				'neo_activity_log',
				'job_queue',
				'short_id_counters',
			]);
			expect(names).toHaveLength(9);
		});

		it('room scope returns the correct set of tables', () => {
			const config = getScopeConfig('room');
			const names = tableNames(config);
			expect(names).toEqual([
				'tasks',
				'goals',
				'mission_executions',
				'mission_metric_history',
				'room_github_mappings',
				'room_mcp_enablement',
				'room_skill_overrides',
			]);
			expect(names).toHaveLength(7);
		});

		it('space scope returns the correct set of tables', () => {
			const config = getScopeConfig('space');
			const names = tableNames(config);
			expect(names).toEqual([
				'space_agents',
				'space_workflows',
				'space_workflow_nodes',
				'space_workflow_runs',
				'space_tasks',
				'space_worktrees',
				'gate_data',
				'channel_cycles',
			]);
			expect(names).toHaveLength(8);
		});

		it('all table configs have a description', () => {
			for (const scopeType of ['global', 'room', 'space'] as const) {
				for (const table of getScopeConfig(scopeType)) {
					expect(table.description.length).toBeGreaterThan(0);
				}
			}
		});
	});

	// ── Column blacklists ─────────────────────────────────────────────────────

	describe('column blacklists', () => {
		it('sessions blacklist excludes config and session_context', () => {
			const sessions = getScopeConfig('global').find((t) => t.tableName === 'sessions')!;
			expect(sessions.blacklistedColumns).toContain('config');
			expect(sessions.blacklistedColumns).toContain('session_context');
		});

		it('rooms blacklist excludes config', () => {
			const rooms = getScopeConfig('global').find((t) => t.tableName === 'rooms')!;
			expect(rooms.blacklistedColumns).toEqual(['config']);
		});

		it('tasks blacklist excludes restrictions (internal use)', () => {
			const tasks = getScopeConfig('room').find((t) => t.tableName === 'tasks')!;
			expect(tasks.blacklistedColumns).toContain('restrictions');
		});

		it('app_mcp_servers blacklist excludes env', () => {
			const mcp = getScopeConfig('global').find((t) => t.tableName === 'app_mcp_servers')!;
			expect(mcp.blacklistedColumns).toEqual(['env']);
		});

		it('inbox_items blacklist excludes raw_event and security_check', () => {
			const inbox = getScopeConfig('global').find((t) => t.tableName === 'inbox_items')!;
			expect(inbox.blacklistedColumns).toContain('raw_event');
			expect(inbox.blacklistedColumns).toContain('security_check');
		});

		it('space_workflows blacklist excludes config, gates, and channels', () => {
			const wf = getScopeConfig('space').find((t) => t.tableName === 'space_workflows')!;
			expect(wf.blacklistedColumns).toContain('config');
			expect(wf.blacklistedColumns).toContain('gates');
			expect(wf.blacklistedColumns).toContain('channels');
		});

		it('space_workflow_nodes blacklist excludes config', () => {
			const nodes = getScopeConfig('space').find((t) => t.tableName === 'space_workflow_nodes')!;
			expect(nodes.blacklistedColumns).toEqual(['config']);
		});

		it('getBlacklistedColumns returns empty array for tables with no blacklist', () => {
			expect(getBlacklistedColumns('skills')).toEqual([]);
			expect(getBlacklistedColumns('goals')).toEqual([]);
			expect(getBlacklistedColumns('nonexistent_table')).toEqual([]);
		});

		it('getBlacklistedColumns returns correct blacklist for known tables', () => {
			expect(getBlacklistedColumns('sessions')).toContain('config');
			expect(getBlacklistedColumns('app_mcp_servers')).toContain('env');
			expect(getBlacklistedColumns('space_agents')).toContain('system_prompt');
			expect(getBlacklistedColumns('neo_activity_log')).toContain('undo_data');
			expect(getBlacklistedColumns('job_queue')).toContain('payload');
			expect(getBlacklistedColumns('tasks')).toContain('restrictions');
		});
	});

	// ── getScopeForSession ────────────────────────────────────────────────────

	describe('getScopeForSession', () => {
		it('maps roomId to room scope', () => {
			const result = getScopeForSession({ roomId: 'room-123' });
			expect(result).toEqual({ scopeType: 'room', scopeValue: 'room-123' });
		});

		it('maps spaceId to space scope when no roomId', () => {
			const result = getScopeForSession({ spaceId: 'space-456' });
			expect(result).toEqual({ scopeType: 'space', scopeValue: 'space-456' });
		});

		it('prefers roomId over spaceId when both are present', () => {
			const result = getScopeForSession({ roomId: 'room-1', spaceId: 'space-2' });
			expect(result).toEqual({ scopeType: 'room', scopeValue: 'room-1' });
		});

		it('returns global scope when neither roomId nor spaceId', () => {
			const result = getScopeForSession({});
			expect(result).toEqual({ scopeType: 'global', scopeValue: '' });
		});

		it('returns global scope when only other fields are present', () => {
			const result = getScopeForSession({ lobbyId: 'lobby-1', taskId: 'task-1' });
			expect(result).toEqual({ scopeType: 'global', scopeValue: '' });
		});
	});

	// ── Sensitive tables never in any scope ───────────────────────────────────

	describe('sensitive table exclusion', () => {
		it('auth_config is not in any scope', () => {
			for (const scopeType of ['global', 'room', 'space'] as const) {
				const names = getAccessibleTableNames(scopeType);
				expect(names).not.toContain('auth_config');
			}
		});

		it('global_tools_config is not in any scope', () => {
			for (const scopeType of ['global', 'room', 'space'] as const) {
				expect(getAccessibleTableNames(scopeType)).not.toContain('global_tools_config');
			}
		});

		it('global_settings is not in any scope', () => {
			for (const scopeType of ['global', 'room', 'space'] as const) {
				expect(getAccessibleTableNames(scopeType)).not.toContain('global_settings');
			}
		});

		it('sdk_messages is not in any scope', () => {
			for (const scopeType of ['global', 'room', 'space'] as const) {
				expect(getAccessibleTableNames(scopeType)).not.toContain('sdk_messages');
			}
		});

		it('internal infrastructure tables are not in any scope', () => {
			const internalTables = ['session_groups', 'session_group_members', 'task_group_events'];
			for (const scopeType of ['global', 'room', 'space'] as const) {
				const names = getAccessibleTableNames(scopeType);
				for (const table of internalTables) {
					expect(names).not.toContain(table);
				}
			}
		});

		it('node_executions is not in any scope', () => {
			for (const scopeType of ['global', 'room', 'space'] as const) {
				expect(getAccessibleTableNames(scopeType)).not.toContain('node_executions');
			}
		});
	});

	// ── Dropped tables ────────────────────────────────────────────────────────

	describe('dropped tables', () => {
		const droppedTables = [
			'space_session_groups',
			'space_session_group_members',
			'space_workflow_transitions',
		];

		it('dropped tables are not in any scope config', () => {
			for (const scopeType of ['global', 'room', 'space'] as const) {
				const names = getAccessibleTableNames(scopeType);
				for (const table of droppedTables) {
					expect(names).not.toContain(table);
				}
			}
		});

		it('dropped tables are in getExcludedTableNames', () => {
			const excluded = getExcludedTableNames();
			for (const table of droppedTables) {
				expect(excluded).toContain(table);
			}
		});
	});

	// ── getExcludedTableNames ─────────────────────────────────────────────────

	describe('getExcludedTableNames', () => {
		it('includes all sensitive tables', () => {
			const excluded = getExcludedTableNames();
			expect(excluded).toContain('auth_config');
			expect(excluded).toContain('global_tools_config');
			expect(excluded).toContain('global_settings');
		});

		it('includes sdk_messages', () => {
			expect(getExcludedTableNames()).toContain('sdk_messages');
		});

		it('includes internal infrastructure tables', () => {
			const excluded = getExcludedTableNames();
			expect(excluded).toContain('session_groups');
			expect(excluded).toContain('session_group_members');
			expect(excluded).toContain('task_group_events');
			expect(excluded).toContain('node_executions');
		});

		it('includes all dropped tables', () => {
			const excluded = getExcludedTableNames();
			expect(excluded).toContain('space_session_groups');
			expect(excluded).toContain('space_session_group_members');
			expect(excluded).toContain('space_workflow_transitions');
			expect(excluded).toContain('messages');
			expect(excluded).toContain('tool_calls');
		});

		it('includes dynamically created tables', () => {
			const excluded = getExcludedTableNames();
			expect(excluded).toContain('github_filter_configs');
		});

		it('returns a non-empty array', () => {
			expect(getExcludedTableNames().length).toBeGreaterThan(0);
		});

		it('excluded tables do not overlap with any accessible tables', () => {
			const excluded = new Set(getExcludedTableNames());
			for (const scopeType of ['global', 'room', 'space'] as const) {
				const accessible = getAccessibleTableNames(scopeType);
				for (const name of accessible) {
					expect(excluded.has(name)).toBe(false);
				}
			}
		});
	});

	// ── buildScopeFilter ──────────────────────────────────────────────────────

	describe('buildScopeFilter', () => {
		it('returns empty filter for global scope tables (no scopeColumn or scopeJoin)', () => {
			const sessions = getScopeConfig('global').find((t) => t.tableName === 'sessions')!;
			const result = buildScopeFilter(sessions, 'unused');
			expect(result).toEqual({ whereClause: '', params: [] });
		});

		it('produces direct scope filter for room-scoped tables with scopeColumn', () => {
			const tasks = getScopeConfig('room').find((t) => t.tableName === 'tasks')!;
			expect(tasks.scopeColumn).toBe('room_id');
			const result = buildScopeFilter(tasks, 'room-abc');
			expect(result.whereClause).toBe('room_id = ?');
			expect(result.params).toEqual(['room-abc']);
		});

		it('produces direct scope filter for goals', () => {
			const goals = getScopeConfig('room').find((t) => t.tableName === 'goals')!;
			const result = buildScopeFilter(goals, 'room-xyz');
			expect(result.whereClause).toBe('room_id = ?');
			expect(result.params).toEqual(['room-xyz']);
		});

		it('produces direct scope filter for space-scoped tables', () => {
			const agents = getScopeConfig('space').find((t) => t.tableName === 'space_agents')!;
			expect(agents.scopeColumn).toBe('space_id');
			const result = buildScopeFilter(agents, 'space-123');
			expect(result.whereClause).toBe('space_id = ?');
			expect(result.params).toEqual(['space-123']);
		});

		it('produces indirect scope filter for mission_executions via goals', () => {
			const execs = getScopeConfig('room').find((t) => t.tableName === 'mission_executions')!;
			expect(execs.scopeJoin).toBeDefined();
			expect(execs.scopeJoin!.localColumn).toBe('goal_id');
			expect(execs.scopeJoin!.joinTable).toBe('goals');
			expect(execs.scopeJoin!.joinPkColumn).toBe('id');
			expect(execs.scopeJoin!.scopeColumn).toBe('room_id');

			const result = buildScopeFilter(execs, 'room-42');
			expect(result.whereClause).toBe('goal_id IN (SELECT id FROM goals WHERE room_id = ?)');
			expect(result.params).toEqual(['room-42']);
		});

		it('produces indirect scope filter for mission_metric_history via goals', () => {
			const history = getScopeConfig('room').find((t) => t.tableName === 'mission_metric_history')!;
			const result = buildScopeFilter(history, 'room-99');
			expect(result.whereClause).toBe('goal_id IN (SELECT id FROM goals WHERE room_id = ?)');
			expect(result.params).toEqual(['room-99']);
		});

		it('produces indirect scope filter for space_workflow_nodes via space_workflows', () => {
			const nodes = getScopeConfig('space').find((t) => t.tableName === 'space_workflow_nodes')!;
			expect(nodes.scopeJoin).toBeDefined();
			expect(nodes.scopeJoin!.localColumn).toBe('workflow_id');
			expect(nodes.scopeJoin!.joinTable).toBe('space_workflows');
			expect(nodes.scopeJoin!.joinPkColumn).toBe('id');
			expect(nodes.scopeJoin!.scopeColumn).toBe('space_id');

			const result = buildScopeFilter(nodes, 'space-alpha');
			expect(result.whereClause).toBe(
				'workflow_id IN (SELECT id FROM space_workflows WHERE space_id = ?)'
			);
			expect(result.params).toEqual(['space-alpha']);
		});

		it('produces indirect scope filter for gate_data via space_workflow_runs', () => {
			const gateData = getScopeConfig('space').find((t) => t.tableName === 'gate_data')!;
			expect(gateData.scopeJoin).toBeDefined();
			expect(gateData.scopeJoin!.localColumn).toBe('run_id');
			expect(gateData.scopeJoin!.joinTable).toBe('space_workflow_runs');
			expect(gateData.scopeJoin!.joinPkColumn).toBe('id');
			expect(gateData.scopeJoin!.scopeColumn).toBe('space_id');

			const result = buildScopeFilter(gateData, 'space-beta');
			expect(result.whereClause).toBe(
				'run_id IN (SELECT id FROM space_workflow_runs WHERE space_id = ?)'
			);
			expect(result.params).toEqual(['space-beta']);
		});

		it('produces indirect scope filter for channel_cycles via space_workflow_runs', () => {
			const cycles = getScopeConfig('space').find((t) => t.tableName === 'channel_cycles')!;
			expect(cycles.scopeJoin).toBeDefined();
			expect(cycles.scopeJoin!.localColumn).toBe('run_id');

			const result = buildScopeFilter(cycles, 'space-gamma');
			expect(result.whereClause).toBe(
				'run_id IN (SELECT id FROM space_workflow_runs WHERE space_id = ?)'
			);
			expect(result.params).toEqual(['space-gamma']);
		});

		it('all indirect scope filters produce valid SQL with one parameter', () => {
			// Collect all indirect configs across all scopes
			const indirectConfigs: ScopeTableConfig[] = [];
			for (const scopeType of ['global', 'room', 'space'] as const) {
				for (const cfg of getScopeConfig(scopeType)) {
					if (cfg.scopeJoin) {
						indirectConfigs.push(cfg);
					}
				}
			}

			expect(indirectConfigs.length).toBeGreaterThan(0);

			for (const cfg of indirectConfigs) {
				const result = buildScopeFilter(cfg, 'test-scope-value');
				// Should contain IN subquery pattern
				expect(result.whereClause).toContain('IN (SELECT');
				expect(result.whereClause).toContain('FROM');
				expect(result.whereClause).toContain('WHERE');
				expect(result.whereClause).toContain('?');
				// Exactly one parameter
				expect(result.params).toHaveLength(1);
				expect(result.params[0]).toBe('test-scope-value');
			}
		});

		it('all direct scope filters produce equality clause with one parameter', () => {
			const directConfigs: ScopeTableConfig[] = [];
			for (const scopeType of ['global', 'room', 'space'] as const) {
				for (const cfg of getScopeConfig(scopeType)) {
					if (cfg.scopeColumn) {
						directConfigs.push(cfg);
					}
				}
			}

			expect(directConfigs.length).toBeGreaterThan(0);

			for (const cfg of directConfigs) {
				const result = buildScopeFilter(cfg, 'test-scope-value');
				expect(result.whereClause).toBe(`${cfg.scopeColumn} = ?`);
				expect(result.params).toHaveLength(1);
				expect(result.params[0]).toBe('test-scope-value');
			}
		});
	});

	// ── Scope filter enforcement ──────────────────────────────────────────────

	describe('scope filter enforcement', () => {
		it('every room-scoped table has scopeColumn or scopeJoin', () => {
			const unfiltered: string[] = [];
			for (const table of getScopeConfig('room')) {
				if (!table.scopeColumn && !table.scopeJoin) {
					unfiltered.push(table.tableName);
				}
			}
			expect(unfiltered).toEqual([]);
		});

		it('every space-scoped table has scopeColumn or scopeJoin', () => {
			const unfiltered: string[] = [];
			for (const table of getScopeConfig('space')) {
				if (!table.scopeColumn && !table.scopeJoin) {
					unfiltered.push(table.tableName);
				}
			}
			expect(unfiltered).toEqual([]);
		});
	});

	// ── Cross-cutting: no duplicate table names across scopes ─────────────────

	describe('table name uniqueness', () => {
		it('no table appears in more than one scope', () => {
			const allTables = new Map<string, string[]>();
			for (const scopeType of ['global', 'room', 'space'] as const) {
				for (const name of getAccessibleTableNames(scopeType)) {
					const existing = allTables.get(name) ?? [];
					existing.push(scopeType);
					allTables.set(name, existing);
				}
			}

			const duplicates: string[] = [];
			for (const [name, scopes] of allTables) {
				if (scopes.length > 1) {
					duplicates.push(`${name}: ${scopes.join(', ')}`);
				}
			}
			expect(duplicates).toEqual([]);
		});
	});

	// ── Schema evolution: every actual DB table is accounted for ──────────────

	describe('schema evolution', () => {
		it('every table in the actual schema is either in a scope config or in the excluded list', () => {
			// Create a fresh in-memory database with the full schema
			const db = new Database(':memory:');
			runMigrations(db, () => {});
			createTables(db);

			// Query sqlite_master for all actual table names
			const rows = db
				.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all() as {
				name: string;
			}[];
			const actualTables = new Set(
				rows
					.map((r) => r.name)
					// Filter out internal SQLite tables (sqlite_sequence is auto-created for AUTOINCREMENT)
					.filter((name) => !name.startsWith('sqlite_'))
			);

			// Collect all tables that are either in a scope config or excluded
			const accountedFor = new Set<string>();
			for (const scopeType of ['global', 'room', 'space'] as const) {
				for (const name of getAccessibleTableNames(scopeType)) {
					accountedFor.add(name);
				}
			}
			for (const name of getExcludedTableNames()) {
				accountedFor.add(name);
			}

			// Every actual table must be accounted for
			const unaccounted: string[] = [];
			for (const tableName of actualTables) {
				if (!accountedFor.has(tableName)) {
					unaccounted.push(tableName);
				}
			}
			expect(unaccounted).toEqual([]);
		});
	});
});
