/**
 * Settings RPC Handlers
 *
 * Provides RPC methods for managing global and session-specific settings.
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { GlobalSettings } from '@neokai/shared';
import type { SettingsManager } from '../settings-manager';
import type { Database } from '../../storage/database';
import type { SessionSettingsOverride } from '../../storage';

export function registerSettingsHandlers(
	messageHub: MessageHub,
	settingsManager: SettingsManager,
	daemonHub: DaemonHub,
	db: Database
) {
	/**
	 * Get global settings
	 */
	messageHub.handle('settings.global.get', async () => {
		return settingsManager.getGlobalSettings();
	});

	/**
	 * Update global settings (partial update)
	 */
	messageHub.handle(
		'settings.global.update',
		async (data: { updates: Partial<GlobalSettings> }) => {
			const updated = settingsManager.updateGlobalSettings(data.updates);
			// Emit event for StateManager to broadcast (global event)
			daemonHub.emit('settings.updated', {
				sessionId: 'global',
				settings: updated,
			});

			// SPECIAL CASE: If showArchived changed, also broadcast sessions change
			// because the filtered session list needs to update
			if ('showArchived' in data.updates) {
				daemonHub.emit('sessions.filterChanged', { sessionId: 'global' });
			}

			return { success: true, settings: updated };
		}
	);

	/**
	 * Save global settings (full replace)
	 */
	messageHub.handle('settings.global.save', async (data: { settings: GlobalSettings }) => {
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
	messageHub.handle(
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
	messageHub.handle('settings.mcp.getDisabled', async () => {
		return {
			disabledServers: settingsManager.getDisabledMcpServers(),
		};
	});

	/**
	 * Set list of disabled MCP servers
	 */
	messageHub.handle('settings.mcp.setDisabled', async (data: { disabledServers: string[] }) => {
		await settingsManager.setDisabledMcpServers(data.disabledServers);
		// Emit event for StateManager to broadcast (global event)
		const settings = settingsManager.getGlobalSettings();
		daemonHub.emit('settings.updated', { sessionId: 'global', settings });
		return { success: true };
	});

	/**
	 * Read file-only settings from .claude/settings.local.json
	 */
	messageHub.handle('settings.fileOnly.read', async () => {
		return settingsManager.readFileOnlySettings();
	});

	/**
	 * List MCP servers from enabled setting sources
	 *
	 * IMPORTANT: Reads from session-specific workspace path for worktree isolation.
	 * - If sessionId provided: Reads from session's workspace (worktree or shared)
	 * - If sessionId omitted: Reads from global workspace root (for GlobalSettingsEditor)
	 */
	messageHub.handle('settings.mcp.listFromSources', async (data?: { sessionId?: string }) => {
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
			effectiveSettings = new (await import('../settings-manager')).SettingsManager(
				db,
				session.workspacePath
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
	messageHub.handle(
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
	 * Get session settings (including merged global + overrides)
	 *
	 * Returns the effective settings for a session, merging global settings
	 * with any session-specific overrides.
	 */
	messageHub.handle('settings.session.get', async (data: { sessionId: string }) => {
		const { sessionId } = data;

		// Validate session exists
		const session = db.getSession(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		// Get global settings as base
		const globalSettings = settingsManager.getGlobalSettings();

		// Get session overrides
		const overrides = db.settings.getSessionSettings(sessionId);

		// Merge: global + overrides (overrides take precedence)
		const effectiveSettings: GlobalSettings & { sessionId: string } = {
			...globalSettings,
			...overrides,
			sessionId,
		};

		return {
			sessionId,
			settings: effectiveSettings,
			overrides,
			hasOverrides: Object.keys(overrides).length > 0,
		};
	});

	/**
	 * Update session settings (partial update)
	 *
	 * Updates session-specific settings overrides. Only the fields provided
	 * in updates will be modified; other fields remain unchanged.
	 */
	messageHub.handle(
		'settings.session.update',
		async (data: { sessionId: string; updates: Partial<SessionSettingsOverride> }) => {
			const { sessionId, updates } = data;

			// Validate session exists
			const session = db.getSession(sessionId);
			if (!session) {
				throw new Error(`Session not found: ${sessionId}`);
			}

			// Validate that only allowed override fields are being updated
			const allowedFields: Array<keyof SessionSettingsOverride> = [
				'model',
				'thinkingLevel',
				'autoScroll',
				'coordinatorMode',
			];

			const invalidFields = Object.keys(updates).filter(
				(key) => !allowedFields.includes(key as keyof SessionSettingsOverride)
			);

			if (invalidFields.length > 0) {
				throw new Error(
					`Invalid session settings fields: ${invalidFields.join(', ')}. ` +
						`Allowed fields: ${allowedFields.join(', ')}`
				);
			}

			// Update session overrides
			const updatedOverrides = db.settings.updateSessionSettings(sessionId, updates);

			// Emit event for StateManager to broadcast
			daemonHub.emit('session.settings.updated', {
				sessionId,
			});

			return {
				success: true,
				sessionId,
				overrides: updatedOverrides,
			};
		}
	);

	/**
	 * Reset session settings (clear all overrides)
	 *
	 * Removes all session-specific overrides, causing the session to use
	 * global settings exclusively.
	 */
	messageHub.handle('settings.session.reset', async (data: { sessionId: string }) => {
		const { sessionId } = data;

		// Validate session exists
		const session = db.getSession(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		// Delete session overrides
		db.settings.deleteSessionSettings(sessionId);

		// Emit event for StateManager to broadcast
		daemonHub.emit('session.settings.updated', {
			sessionId,
		});

		return {
			success: true,
			sessionId,
		};
	});
}
