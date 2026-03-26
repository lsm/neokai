/**
 * Application-level Skills Registry Types
 *
 * These types define the schema for Skills registered at the application level.
 * Registered skills are available to any room or session that enables them.
 *
 * Source type guide:
 * - 'builtin'    — references a slash command in .claude/commands/
 * - 'plugin'     — references a local plugin directory on disk
 * - 'mcp_server' — references an existing app_mcp_servers entry by ID;
 *                  avoids duplicating MCP server config that is already
 *                  managed by the app-level MCP registry
 */

export type SkillSourceType = 'builtin' | 'plugin' | 'mcp_server';

/** Config for a built-in skill backed by a .claude/commands/ slash command. */
export interface BuiltinSkillConfig {
	/** The slash-command name (e.g. "update-config", "claude-api"). */
	commandName: string;
}

/** Config for a skill backed by a local plugin directory. */
export interface PluginSkillConfig {
	/** Absolute path to the plugin directory on disk. */
	pluginPath: string;
}

/**
 * Config for a skill backed by an existing app-level MCP server.
 * References the server by its UUID in app_mcp_servers — no config duplication.
 */
export interface McpServerSkillConfig {
	/** UUID of the corresponding `app_mcp_servers` row. */
	appMcpServerId: string;
}

/** Discriminated union of all possible skill configurations. */
export type AppSkillConfig = BuiltinSkillConfig | PluginSkillConfig | McpServerSkillConfig;

/** Lifecycle validation state of a skill. */
export type SkillValidationStatus = 'pending' | 'valid' | 'invalid' | 'unknown';

/**
 * A skill registered at the application level.
 * Skills can originate from built-in commands, local plugins, or MCP servers.
 */
export interface AppSkill {
	/** Unique identifier (UUID). */
	id: string;
	/** Internal unique name (slug-style, e.g. "web-search"). */
	name: string;
	/** Human-readable display name shown in the UI. */
	displayName: string;
	/** Short description of what the skill does (used for agent discovery). */
	description: string;
	/** Where the skill comes from. */
	sourceType: SkillSourceType;
	/** Source-type-specific configuration. */
	config: AppSkillConfig;
	/** Whether this skill is globally enabled. */
	enabled: boolean;
	/** True when the skill is shipped with NeoKai and cannot be deleted. */
	builtIn: boolean;
	/** Current validation state (set by the async validation job). */
	validationStatus: SkillValidationStatus;
	/** ISO-8601 timestamp when the record was created. */
	createdAt: string;
}

/**
 * Payload for creating a new skill entry.
 * `id`, `createdAt`, and `builtIn` are generated / set server-side.
 */
export type CreateSkillParams = Omit<AppSkill, 'id' | 'createdAt' | 'builtIn'>;

/**
 * Payload for updating an existing skill entry.
 * All CreateSkillParams fields are optional.
 */
export type UpdateSkillParams = Partial<CreateSkillParams>;
