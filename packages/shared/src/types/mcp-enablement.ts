/**
 * MCP Enablement Override Types
 *
 * Unified override model for application-level MCP server registry entries.
 * A row in `mcp_enablement` represents an explicit per-scope override that
 * either enables or disables a registry server for the given scope (space,
 * room, or session). Missing rows mean "inherit" — the next most-specific
 * scope with an override wins, otherwise the server's registry default is used.
 *
 * Precedence (most specific wins): session > room > space > registry default.
 */

/**
 * The scope at which an MCP enablement override applies.
 * - `space`  — applies to all sessions whose `session.context.spaceId` matches.
 * - `room`   — applies to all sessions whose `session.context.roomId` matches.
 * - `session` — applies only to a specific session by its ID.
 */
export type McpEnablementScopeType = 'space' | 'room' | 'session';

/**
 * A single override row. Present row = explicit override; missing row = inherit.
 *
 * Identity is the composite natural key (serverId, scopeType, scopeId); there
 * is no surrogate `id` column. Callers that need to reference a specific row
 * do so by that triple.
 */
export interface McpEnablementOverride {
	/** The scope at which this override applies. */
	scopeType: McpEnablementScopeType;
	/** The ID of the space/room/session this override targets. */
	scopeId: string;
	/** The `app_mcp_servers.id` of the registry entry this override affects. */
	serverId: string;
	/** `true` = explicitly enabled for this scope; `false` = explicitly disabled. */
	enabled: boolean;
}

// ---------------------------------------------------------------------------
// RPC request/response shapes
// ---------------------------------------------------------------------------

/** `mcp.enablement.list` — list every override at a given (scopeType, scopeId). */
export interface McpEnablementListRequest {
	scopeType: McpEnablementScopeType;
	scopeId: string;
}

export interface McpEnablementListResponse {
	overrides: McpEnablementOverride[];
}

/**
 * `mcp.enablement.setOverride` — upsert an override (enable or disable a single
 * server at a given scope). Use `mcp.enablement.clearOverride` to remove it and
 * revert to inheritance.
 */
export interface McpEnablementSetOverrideRequest {
	scopeType: McpEnablementScopeType;
	scopeId: string;
	serverId: string;
	enabled: boolean;
}

export interface McpEnablementSetOverrideResponse {
	override: McpEnablementOverride;
}

/** `mcp.enablement.clearOverride` — delete a single (scope, server) override. */
export interface McpEnablementClearOverrideRequest {
	scopeType: McpEnablementScopeType;
	scopeId: string;
	serverId: string;
}

export interface McpEnablementClearOverrideResponse {
	deleted: boolean;
}

/** `mcp.enablement.clearScope` — delete every override at a given scope. */
export interface McpEnablementClearScopeRequest {
	scopeType: McpEnablementScopeType;
	scopeId: string;
}

export interface McpEnablementClearScopeResponse {
	deleted: number;
}
