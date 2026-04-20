/**
 * Settings RPC Handlers
 *
 * Provides RPC methods for managing global and session-specific settings.
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { GlobalSettings, SessionSettings } from '@neokai/shared';
import type { SettingsManager } from '../settings-manager';
import type { Database } from '../../storage/database';

export function registerSettingsHandlers(
	messageHub: MessageHub,
	settingsManager: SettingsManager,
	daemonHub: DaemonHub,
	db: Database
) {
	/**
	 * Get global settings
	 */
	messageHub.onRequest('settings.global.get', async () => {
		return settingsManager.getGlobalSettings();
	});

	/**
	 * Update global settings (partial update)
	 */
	messageHub.onRequest(
		'settings.global.update',
		async (data: { updates: Partial<GlobalSettings> }) => {
			const updated = settingsManager.updateGlobalSettings(data.updates);
			// Emit event for StateManager to broadcast (global event)
			daemonHub.emit('settings.updated', {
				sessionId: 'global',
				settings: updated,
			});

			// Note: showArchived filter is now handled client-side via LiveQuery (sessions.list)

			return { success: true, settings: updated };
		}
	);

	/**
	 * Save global settings (full replace)
	 */
	messageHub.onRequest('settings.global.save', async (data: { settings: GlobalSettings }) => {
		settingsManager.saveGlobalSettings(data.settings);
		// Emit event for StateManager to broadcast (global event)
		daemonHub.emit('settings.updated', {
			sessionId: 'global',
			settings: data.settings,
		});
		return { success: true };
	});

	/**
	 * Toggle MCP server enabled/disabled
	 */
	messageHub.onRequest(
		'settings.mcp.toggle',
		async (data: { serverName: string; enabled: boolean }) => {
			await settingsManager.toggleMcpServer(data.serverName, data.enabled);
			// Emit event for StateManager to broadcast (global event)
			const settings = settingsManager.getGlobalSettings();
			daemonHub.emit('settings.updated', { sessionId: 'global', settings });
			return { success: true };
		}
	);

	/**
	 * Get list of disabled MCP servers
	 */
	messageHub.onRequest('settings.mcp.getDisabled', async () => {
		return {
			disabledServers: settingsManager.getDisabledMcpServers(),
		};
	});

	/**
	 * Set list of disabled MCP servers
	 */
	messageHub.onRequest('settings.mcp.setDisabled', async (data: { disabledServers: string[] }) => {
		await settingsManager.setDisabledMcpServers(data.disabledServers);
		// Emit event for StateManager to broadcast (global event)
		const settings = settingsManager.getGlobalSettings();
		daemonHub.emit('settings.updated', { sessionId: 'global', settings });
		return { success: true };
	});

	/**
	 * Read file-only settings from .claude/settings.local.json
	 */
	messageHub.onRequest('settings.fileOnly.read', async () => {
		return settingsManager.readFileOnlySettings();
	});

	/**
	 * List MCP servers from enabled setting sources
	 *
	 * IMPORTANT: Reads from session-specific workspace path for worktree isolation.
	 * - If sessionId provided: Reads from session's workspace (worktree or shared)
	 * - If sessionId omitted: Reads from global workspace root (for GlobalSettingsEditor)
	 */
	messageHub.onRequest('settings.mcp.listFromSources', async (data?: { sessionId?: string }) => {
		let effectiveSettings = settingsManager; // Default: global workspace root

		// If sessionId provided, use session-specific workspace path
		if (data?.sessionId) {
			const session = db.getSession(data.sessionId);
			if (!session) {
				throw new Error(`Session not found: ${data.sessionId}`);
			}

			// Create session-specific SettingsManager with session's workspace path
			// This ensures we read .mcp.json and settings files from the correct location:
			// - Worktree sessions: .worktrees/{sessionId}/.mcp.json
			// - Non-worktree sessions: {workspaceRoot}/.mcp.json
			const workspacePath = session.worktree?.worktreePath ?? session.workspacePath ?? undefined;
			effectiveSettings = new (await import('../settings-manager')).SettingsManager(
				db,
				workspacePath
			);
		}

		return {
			servers: effectiveSettings.listMcpServersFromSources(),
			serverSettings: settingsManager.getMcpServerSettings(), // Global server settings
		};
	});

	/**
	 * Update per-server MCP settings (allowed/defaultOn)
	 */
	messageHub.onRequest(
		'settings.mcp.updateServerSettings',
		async (data: { serverName: string; settings: { allowed?: boolean; defaultOn?: boolean } }) => {
			settingsManager.updateMcpServerSettings(data.serverName, data.settings);
			// Emit event for StateManager to broadcast (global event)
			const settings = settingsManager.getGlobalSettings();
			daemonHub.emit('settings.updated', { sessionId: 'global', settings });
			return { success: true };
		}
	);

	/**
	 * Get session settings (placeholder for future session-specific settings)
	 *
	 * Currently, session settings are stored in session.config, but this
	 * handler provides a unified interface for future expansion.
	 */
	messageHub.onRequest('settings.session.get', async (data: { sessionId: string }) => {
		// Future: retrieve session-specific settings
		// For now, return empty object
		return {
			sessionId: data.sessionId,
			settings: {},
		};
	});

	/**
	 * Update session settings (placeholder for future session-specific settings)
	 */
	messageHub.onRequest(
		'settings.session.update',
		async (data: { sessionId: string; updates: Partial<SessionSettings> }) => {
			// Future: update session-specific settings
			// For now, do nothing
			return { success: true, sessionId: data.sessionId };
		}
	);

	/**
	 * Calculate usage analytics from all user sessions.
	 *
	 * Aggregates cost, tokens, and messages from the sessions table.
	 * Filters out internal room/space/agent sessions server-side.
	 * Called on-demand when the Usage Analytics settings tab is opened.
	 */
	messageHub.onRequest('usage.calculate', async () => {
		const database = db.getDatabase();

		// Aggregate totals
		const totals = database
			.prepare(
				`SELECT
					COALESCE(SUM(json_extract(metadata, '$.totalCost')), 0) as totalCost,
					COALESCE(SUM(json_extract(metadata, '$.totalTokens')), 0) as totalTokens,
					COALESCE(SUM(json_extract(metadata, '$.messageCount')), 0) as totalMessages,
				COUNT(*) as sessionCount
				FROM sessions
				WHERE type NOT IN ('lobby', 'spaces_global', 'neo', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
					  AND json_extract(session_context, '$.roomId') IS NULL
					  AND json_extract(session_context, '$.spaceId') IS NULL`
			)
			.get() as {
			totalCost: number;
			totalTokens: number;
			totalMessages: number;
			sessionCount: number;
		};

		// Top 10 sessions by cost
		const topSessions = database
			.prepare(
				`SELECT
					id,
					title,
					json_extract(metadata, '$.totalCost') as cost,
					json_extract(metadata, '$.totalTokens') as tokens,
					json_extract(metadata, '$.messageCount') as messages
				FROM sessions
				WHERE type NOT IN ('lobby', 'spaces_global', 'neo', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
				  AND json_extract(session_context, '$.roomId') IS NULL
				  AND json_extract(session_context, '$.spaceId') IS NULL
				  AND json_extract(metadata, '$.totalCost') > 0
				ORDER BY cost DESC
				LIMIT 10`
			)
			.all() as Array<{
			id: string;
			title: string;
			cost: number;
			tokens: number;
			messages: number;
		}>;

		// Daily costs for last 14 days
		const dailyCosts = database
			.prepare(
				`SELECT
					date(created_at) as date,
					COALESCE(SUM(json_extract(metadata, '$.totalCost')), 0) as cost
				FROM sessions
				WHERE type NOT IN ('lobby', 'spaces_global', 'neo', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
				  AND json_extract(session_context, '$.roomId') IS NULL
				  AND json_extract(session_context, '$.spaceId') IS NULL
				  AND created_at >= date('now', '-14 days')
				GROUP BY date(created_at)
				ORDER BY date ASC`
			)
			.all() as Array<{ date: string; cost: number }>;

		return {
			totalCost: totals.totalCost,
			totalTokens: totals.totalTokens,
			totalMessages: totals.totalMessages,
			sessionCount: totals.sessionCount,
			topSessions,
			dailyCosts,
		};
	});
}
