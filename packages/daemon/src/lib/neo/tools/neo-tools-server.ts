/**
 * Neo Tools Server
 *
 * Creates the combined set of Neo MCP servers (query + action) that are
 * attached to the Neo session at runtime.
 *
 * Two named servers are used so each can be independently identified in
 * logs and collision warnings:
 *   - 'neo-query'  — read-only system-state tools (always created)
 *   - 'neo-action' — write operations with security-tier enforcement (created when actionConfig is provided)
 *
 * Usage:
 *   const servers = createNeoToolsMcpServers(queryConfig, actionConfig);
 *   session.setRuntimeMcpServers({ ...registryServers, ...servers });
 */

import type { McpServerConfig } from '@neokai/shared';
import { createNeoQueryMcpServer, type NeoToolsConfig } from './neo-query-tools';
import { createNeoActionMcpServer, type NeoActionToolsConfig } from './neo-action-tools';

export type { NeoToolsConfig } from './neo-query-tools';
export type { NeoActionToolsConfig } from './neo-action-tools';

/**
 * Create the neo-query and (optionally) neo-action MCP servers and return
 * them as a named map suitable for session.setRuntimeMcpServers().
 *
 * When actionConfig is provided, both servers are created and returned.
 * When omitted, only the neo-query server is returned (backward-compatible).
 *
 * The caller is responsible for merging registry-sourced servers; in-process
 * servers ('neo-query', 'neo-action') always take precedence on name collision.
 */
export function createNeoToolsMcpServers(
	queryConfig: NeoToolsConfig,
	actionConfig?: NeoActionToolsConfig
): Record<string, McpServerConfig> {
	const servers: Record<string, McpServerConfig> = {
		'neo-query': createNeoQueryMcpServer(queryConfig) as unknown as McpServerConfig,
	};
	if (actionConfig) {
		servers['neo-action'] = createNeoActionMcpServer(actionConfig) as unknown as McpServerConfig;
	}
	return servers;
}
