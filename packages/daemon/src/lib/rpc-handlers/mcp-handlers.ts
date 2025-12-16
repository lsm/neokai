/**
 * Tools RPC Handlers
 *
 * Provides RPC methods for managing tools (MCP and built-in).
 * Allows clients to:
 * - Save tools configuration with SDK restart
 * - Enable/disable specific MCP tools per session
 * - Query available MCP servers
 * - Get/set global tools configuration
 */

import type { MessageHub, ToolsConfig, GlobalToolsConfig } from '@liuboer/shared';
import type { SessionManager } from '../session-manager';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function registerMcpHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
	/**
	 * Save tools configuration for a session
	 *
	 * This is a blocking operation that:
	 * 1. Updates session config in memory and DB
	 * 2. Restarts the SDK query to apply changes
	 * 3. Returns success/failure status
	 *
	 * Timeout: 30 seconds
	 */
	messageHub.handle('tools.save', async (data: { sessionId: string; tools: ToolsConfig }) => {
		const { sessionId, tools } = data;

		const agentSession = sessionManager.getSession(sessionId);
		if (!agentSession) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		// Call the agent session's updateToolsConfig method
		// This handles stopping the query, updating config, and restarting
		const result = await agentSession.updateToolsConfig(tools);

		return result;
	});

	/**
	 * Update enabled MCP tools for a session (legacy - kept for backward compatibility)
	 * Now converts to new tools config format
	 */
	messageHub.handle(
		'mcp.updateEnabledTools',
		async (data: { sessionId: string; enabledTools: string[] }) => {
			const { sessionId, enabledTools } = data;

			const agentSession = sessionManager.getSession(sessionId);
			if (!agentSession) {
				throw new Error(`Session not found: ${sessionId}`);
			}

			const session = agentSession.getSessionData();

			// Convert legacy format to new tools config format
			const currentTools = session.config.tools ?? {};
			const newTools: ToolsConfig = {
				...currentTools,
				loadProjectMcp: enabledTools.length > 0,
				enabledMcpPatterns: enabledTools,
			};

			agentSession.updateMetadata({
				config: {
					...session.config,
					tools: newTools,
				},
			});

			return { success: true };
		}
	);

	/**
	 * Get enabled MCP tools for a session
	 */
	messageHub.handle('mcp.getEnabledTools', async (data: { sessionId: string }) => {
		const { sessionId } = data;

		const agentSession = sessionManager.getSession(sessionId);
		if (!agentSession) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const session = agentSession.getSessionData();

		// Return patterns from new tools config format
		return {
			enabledTools: session.config.tools?.enabledMcpPatterns || [],
		};
	});

	/**
	 * List available MCP servers from .mcp.json
	 */
	messageHub.handle('mcp.listServers', async (data: { sessionId: string }) => {
		const { sessionId } = data;

		const agentSession = sessionManager.getSession(sessionId);
		if (!agentSession) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const session = agentSession.getSessionData();
		const mcpConfigPath = join(session.workspacePath, '.mcp.json');

		try {
			const content = await readFile(mcpConfigPath, 'utf-8');
			const config = JSON.parse(content) as { mcpServers: Record<string, unknown> };
			return {
				servers: config.mcpServers || {},
			};
		} catch {
			// .mcp.json doesn't exist or is invalid
			return {
				servers: {},
			};
		}
	});

	// ============================================================================
	// Global Tools Configuration
	// ============================================================================

	/**
	 * Get the global tools configuration
	 */
	messageHub.handle('globalTools.getConfig', async () => {
		const config = sessionManager.getGlobalToolsConfig();
		return { config };
	});

	/**
	 * Save the global tools configuration
	 */
	messageHub.handle('globalTools.saveConfig', async (data: { config: GlobalToolsConfig }) => {
		sessionManager.saveGlobalToolsConfig(data.config);
		return { success: true };
	});
}
