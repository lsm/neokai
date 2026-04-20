import type { SessionContext } from '@neokai/shared';

// ── Types ──────────────────────────────────────────────────────────────────────

/** The three scope levels that determine table access and filter injection. */
export type DbScopeType = 'global' | 'room' | 'space';

/** Configuration for indirect scope resolution via a join table. */
export interface ScopeJoinConfig {
	/** Column on the target table that references the join table (e.g., 'goal_id'). */
	localColumn: string;
	/** The intermediate table used for scope resolution (e.g., 'goals'). */
	joinTable: string;
	/** Primary key column on the join table (e.g., 'id'). */
	joinPkColumn: string;
	/** The scope column on the join table (e.g., 'room_id' or 'space_id'). */
	scopeColumn: string;
}

/** Full configuration for a table within a given scope. */
export interface ScopeTableConfig {
	/** Must match the actual table name in the SQLite schema. */
	tableName: string;
	/** Direct scope column on this table (e.g., 'room_id', 'space_id'). */
	scopeColumn?: string;
	/** Indirect scope resolution via a join table. */
	scopeJoin?: ScopeJoinConfig;
	/** Columns to exclude from `db_describe_table` and `SELECT *`. */
	blacklistedColumns: string[];
	/** Human-readable description for the agent. */
	description: string;
}

/** Resolved scope information for a given session context. */
export interface ResolvedScope {
	scopeType: DbScopeType;
	scopeValue: string;
}

/** Parameterized WHERE clause result from `buildScopeFilter`. */
export interface ScopeFilterResult {
	whereClause: string;
	params: unknown[];
}

// ── Global column blacklist (applied regardless of scope) ─────────────────────

/**
 * Per-table column blacklists. These columns are excluded from
 * `db_describe_table` output and `SELECT *` expansion.
 *
 * Blacklists are global per-table, not scope-dependent.
 */
const COLUMN_BLACKLISTS: Record<string, string[]> = {
	sessions: ['config', 'session_context'],
	rooms: ['config'],
	spaces: ['config'],
	app_mcp_servers: ['env'],
	inbox_items: ['raw_event', 'security_check'],
	neo_activity_log: ['undo_data'],
	job_queue: ['payload'],
	space_agents: ['system_prompt'],
	space_workflows: ['config', 'gates', 'channels'],
	tasks: ['restrictions'], // internal use — agent-imposed task constraints
	space_workflow_nodes: ['config'],
};

// ── Scope configurations ──────────────────────────────────────────────────────

/**
 * Tables visible in the **global** scope (Neo agent / no entity filter).
 * No WHERE clause injection — the agent can read all rows.
 */
const GLOBAL_SCOPE_TABLES: ScopeTableConfig[] = [
	{
		tableName: 'sessions',
		blacklistedColumns: COLUMN_BLACKLISTS.sessions,
		description:
			'Agent sessions with metadata such as title, status, workspace path, type, and timestamps.',
	},
	{
		tableName: 'rooms',
		blacklistedColumns: COLUMN_BLACKLISTS.rooms,
		description:
			'Room definitions with name, instructions, allowed paths, model config, and status.',
	},
	{
		tableName: 'spaces',
		blacklistedColumns: COLUMN_BLACKLISTS.spaces,
		description:
			'Space definitions for multi-agent environments with workspace path, slug, and config.',
	},
	{
		tableName: 'app_mcp_servers',
		blacklistedColumns: COLUMN_BLACKLISTS.app_mcp_servers,
		description:
			'Globally-configured MCP servers with connection details (command, args, URL, headers).',
	},
	{
		tableName: 'skills',
		blacklistedColumns: [],
		// Note: skills.config stores structured config (McpServerSkillConfig with appMcpServerId UUID,
		// PluginSkillConfig with local path) — no raw credentials. If credential-bearing config is
		// ever added to skill configs, it must be blacklisted here and in COLUMN_BLACKLISTS.
		description:
			'Available skills (plugins, MCP servers, built-ins) with config, enablement, and validation status.',
	},
	{
		tableName: 'inbox_items',
		blacklistedColumns: COLUMN_BLACKLISTS.inbox_items,
		description: 'Incoming GitHub events (issues, comments, PRs) routed through the inbox system.',
	},
	{
		tableName: 'neo_activity_log',
		blacklistedColumns: COLUMN_BLACKLISTS.neo_activity_log,
		description:
			'Audit log of Neo agent tool invocations including status, targets, and undo data.',
	},
	{
		tableName: 'job_queue',
		blacklistedColumns: COLUMN_BLACKLISTS.job_queue,
		description:
			'Background job queue entries with status, priority, retry tracking, and scheduling.',
	},
	{
		tableName: 'short_id_counters',
		blacklistedColumns: [],
		description: 'Auto-incrementing short-ID counters keyed by entity type and scope.',
	},
];

/**
 * Tables visible in the **room** scope (room agent).
 * Auto-injects `WHERE room_id = ?` (or indirect equivalent) on all queries.
 */
const ROOM_SCOPE_TABLES: ScopeTableConfig[] = [
	{
		tableName: 'tasks',
		scopeColumn: 'room_id',
		blacklistedColumns: COLUMN_BLACKLISTS.tasks,
		description:
			'Room tasks with title, status, priority, dependencies, PR tracking, and agent assignments.',
	},
	{
		tableName: 'goals',
		scopeColumn: 'room_id',
		blacklistedColumns: [],
		description:
			'Room missions/goals with mission type, autonomy level, schedule, structured metrics, and execution tracking.',
	},
	{
		tableName: 'mission_executions',
		scopeJoin: {
			localColumn: 'goal_id',
			joinTable: 'goals',
			joinPkColumn: 'id',
			scopeColumn: 'room_id',
		},
		blacklistedColumns: [],
		description:
			'Individual execution runs of recurring missions with status, task IDs, and planning attempts.',
	},
	{
		tableName: 'mission_metric_history',
		scopeJoin: {
			localColumn: 'goal_id',
			joinTable: 'goals',
			joinPkColumn: 'id',
			scopeColumn: 'room_id',
		},
		blacklistedColumns: [],
		description: 'Time-series snapshots of measurable mission metrics recorded over time.',
	},
	{
		tableName: 'room_github_mappings',
		scopeColumn: 'room_id',
		blacklistedColumns: [],
		description: 'GitHub repository mappings for rooms with priority ordering.',
	},
	{
		tableName: 'room_mcp_enablement',
		scopeColumn: 'room_id',
		blacklistedColumns: [],
		description: 'Per-room MCP server enablement overrides.',
	},
	{
		tableName: 'room_skill_overrides',
		scopeColumn: 'room_id',
		blacklistedColumns: [],
		description: 'Per-room skill enablement overrides.',
	},
];

/**
 * Tables visible in the **space** scope (space agent).
 * Auto-injects `WHERE space_id = ?` (or indirect equivalent) on all queries.
 */
const SPACE_SCOPE_TABLES: ScopeTableConfig[] = [
	{
		tableName: 'space_agents',
		scopeColumn: 'space_id',
		blacklistedColumns: COLUMN_BLACKLISTS.space_agents,
		description: 'Space agent definitions with name, model, tools, provider, and instructions.',
	},
	{
		tableName: 'space_workflows',
		scopeColumn: 'space_id',
		blacklistedColumns: COLUMN_BLACKLISTS.space_workflows,
		description:
			'Space workflow definitions with graph layout, channel routing, and gate configurations.',
	},
	{
		tableName: 'space_workflow_nodes',
		scopeJoin: {
			localColumn: 'workflow_id',
			joinTable: 'space_workflows',
			joinPkColumn: 'id',
			scopeColumn: 'space_id',
		},
		blacklistedColumns: COLUMN_BLACKLISTS.space_workflow_nodes,
		description:
			'Individual nodes/steps within a space workflow with name, description, and config.',
	},
	{
		tableName: 'space_workflow_runs',
		scopeColumn: 'space_id',
		blacklistedColumns: [],
		description: 'Executions of space workflows with status, timestamps, and failure tracking.',
	},
	{
		tableName: 'space_tasks',
		scopeColumn: 'space_id',
		blacklistedColumns: [],
		description:
			'Tasks within a space with numbering, status, PR tracking, and workflow run associations.',
	},
	{
		tableName: 'space_worktrees',
		scopeColumn: 'space_id',
		blacklistedColumns: [],
		description: 'Git worktree mappings for space tasks with slug and path tracking.',
	},
	{
		tableName: 'gate_data',
		scopeJoin: {
			localColumn: 'run_id',
			joinTable: 'space_workflow_runs',
			joinPkColumn: 'id',
			scopeColumn: 'space_id',
		},
		blacklistedColumns: [],
		description: 'Gate evaluation data for human-in-the-loop approval checkpoints in workflows.',
	},
	{
		tableName: 'channel_cycles',
		scopeJoin: {
			localColumn: 'run_id',
			joinTable: 'space_workflow_runs',
			joinPkColumn: 'id',
			scopeColumn: 'space_id',
		},
		blacklistedColumns: [],
		description: 'Cycle counters for workflow channels to prevent infinite loop execution.',
	},
	{
		tableName: 'workflow_run_artifacts',
		scopeJoin: {
			localColumn: 'run_id',
			joinTable: 'space_workflow_runs',
			joinPkColumn: 'id',
			scopeColumn: 'space_id',
		},
		blacklistedColumns: [],
		description:
			'Typed artifacts produced by workflow node agents (PRs, commit sets, test results, deployments).',
	},
	{
		tableName: 'workflow_run_artifact_cache',
		scopeJoin: {
			localColumn: 'run_id',
			joinTable: 'space_workflow_runs',
			joinPkColumn: 'id',
			scopeColumn: 'space_id',
		},
		blacklistedColumns: [],
		description:
			'JSON-serialised cache of git-derived artifact data (gate diffs, commit log, per-file diffs) populated by background sync jobs and served to the TaskArtifactsPanel.',
	},
];

/**
 * Tables that are intentionally excluded from ALL scopes.
 * These include sensitive config tables, raw message stores, and internal infrastructure.
 */
const EXCLUDED_TABLE_NAMES: string[] = [
	// Sensitive configuration (contains auth tokens, API keys)
	'auth_config',
	'global_tools_config',
	'global_settings',
	// Raw SDK message store (too large, not useful for ad-hoc queries)
	'sdk_messages',
	// Internal session group infrastructure
	'session_groups',
	'session_group_members',
	'task_group_events',
	// Node execution tracking — transient per-run agent state, not useful for ad-hoc queries
	'node_executions',
	// Pending agent messages — internal queue-until-active infrastructure for Task Agent
	// send_message delivery; flushed by TaskAgentManager when target sessions activate.
	'pending_agent_messages',
	// Dynamically created tables (managed by FilterConfigManager, not part of static schema)
	'github_filter_configs',
	// Workspace history — user-level path bookmarks, not useful for agent queries
	'workspace_history',
	// Dropped tables (no longer exist in schema)
	'space_session_groups',
	'space_session_group_members',
	'space_workflow_transitions',
	// Legacy dropped tables
	'messages',
	'tool_calls',
];

// ── Scope config registry ─────────────────────────────────────────────────────

const SCOPE_CONFIGS: Record<DbScopeType, ScopeTableConfig[]> = {
	global: GLOBAL_SCOPE_TABLES,
	room: ROOM_SCOPE_TABLES,
	space: SPACE_SCOPE_TABLES,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the full table configurations for a given scope type.
 */
export function getScopeConfig(scopeType: DbScopeType): ScopeTableConfig[] {
	return SCOPE_CONFIGS[scopeType];
}

/**
 * Resolves the scope type and value from a session context.
 *
 * - roomId present → room scope
 * - spaceId present (no roomId) → space scope
 * - Neither → global scope
 */
export function getScopeForSession(context: SessionContext): ResolvedScope {
	if (context.roomId) {
		return { scopeType: 'room', scopeValue: context.roomId };
	}
	if (context.spaceId) {
		return { scopeType: 'space', scopeValue: context.spaceId };
	}
	return { scopeType: 'global', scopeValue: '' };
}

/**
 * Returns the list of table names accessible within a given scope.
 */
export function getAccessibleTableNames(scopeType: DbScopeType): string[] {
	return SCOPE_CONFIGS[scopeType].map((cfg) => cfg.tableName);
}

/**
 * Returns column blacklists for a given table.
 * Blacklists are global per-table (not scope-dependent).
 * Returns an empty array for tables with no blacklisted columns.
 */
export function getBlacklistedColumns(tableName: string): string[] {
	return COLUMN_BLACKLISTS[tableName] ?? [];
}

/**
 * Returns the list of tables that are excluded from all scopes.
 * Used for schema evolution validation to ensure sensitive/infrastructure
 * tables are never accidentally exposed.
 */
export function getExcludedTableNames(): string[] {
	return [...EXCLUDED_TABLE_NAMES];
}

/**
 * Builds a parameterized WHERE clause for a scoped table configuration.
 *
 * Direct scope:  `room_id = ?`  (one param)
 * Indirect scope: `goal_id IN (SELECT id FROM goals WHERE room_id = ?)`  (one param)
 * Global scope:  returns empty clause (no filtering)
 */
export function buildScopeFilter(
	tableConfig: ScopeTableConfig,
	scopeValue: string
): ScopeFilterResult {
	// Global tables have no scope column or join — no filter needed
	if (!tableConfig.scopeColumn && !tableConfig.scopeJoin) {
		return { whereClause: '', params: [] };
	}

	// Direct scope filter
	if (tableConfig.scopeColumn) {
		return {
			whereClause: `${tableConfig.scopeColumn} = ?`,
			params: [scopeValue],
		};
	}

	// Indirect scope filter via join table
	if (tableConfig.scopeJoin) {
		const join = tableConfig.scopeJoin;
		return {
			whereClause: `${join.localColumn} IN (SELECT ${join.joinPkColumn} FROM ${join.joinTable} WHERE ${join.scopeColumn} = ?)`,
			params: [scopeValue],
		};
	}

	return { whereClause: '', params: [] };
}
