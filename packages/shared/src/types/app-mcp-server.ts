/**
 * Application-level MCP Server Registry Types
 *
 * These types define the schema for MCP servers registered at the application level.
 * Registered servers are available to any room or session that enables them.
 *
 * Env var handling note:
 * The `env` field stores plain JSON key-value pairs intended for non-secret configuration.
 * For secrets such as BRAVE_API_KEY, the field stores a reference key and the actual value
 * is read from the system environment at spawn time (process.env[key]). Do NOT store raw
 * secret values in SQLite.
 */

export type AppMcpServerSourceType = 'stdio' | 'sse' | 'http';

/**
 * An MCP server registered at the application level.
 */
export interface AppMcpServer {
	/** Unique identifier (UUID) */
	id: string;
	/** Human-readable name, unique across the registry */
	name: string;
	/** Optional description of what the server provides */
	description?: string;
	/** Transport type: stdio, SSE, or HTTP */
	sourceType: AppMcpServerSourceType;
	/** Executable command (stdio servers) */
	command?: string;
	/** Command arguments (stdio servers) */
	args?: string[];
	/**
	 * Environment variable overrides for the server process (stdio servers).
	 * Values are non-secret config or reference keys (e.g. "BRAVE_API_KEY" → read from process.env).
	 */
	env?: Record<string, string>;
	/** Server URL (SSE or HTTP servers) */
	url?: string;
	/** Additional HTTP headers (SSE or HTTP servers) */
	headers?: Record<string, string>;
	/** Whether this server is enabled globally */
	enabled: boolean;
	/** Unix timestamp (ms) when the record was created */
	createdAt?: number;
	/** Unix timestamp (ms) when the record was last updated */
	updatedAt?: number;
}

/**
 * Request payload to create a new application-level MCP server entry.
 * `id` is generated server-side.
 */
export type CreateAppMcpServerRequest = Omit<AppMcpServer, 'id'>;

/**
 * Request payload to update an existing application-level MCP server entry.
 * All fields except `id` are optional.
 */
export type UpdateAppMcpServerRequest = { id: string } & Partial<Omit<AppMcpServer, 'id'>>;
