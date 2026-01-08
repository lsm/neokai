/**
 * Tools Configuration Manager
 *
 * Handles global tools configuration for sessions:
 * - Get/save global tools configuration from database
 * - Build default tools config for new sessions based on global settings
 */

import type { Session } from '@liuboer/shared';
import type { Database } from '../../storage/database';
import type { SettingsManager } from '../settings-manager';
import { Logger } from '../logger';

export class ToolsConfigManager {
	private logger: Logger;

	constructor(
		private db: Database,
		private settingsManager: SettingsManager
	) {
		this.logger = new Logger('ToolsConfigManager');
	}

	/**
	 * Get the global tools configuration
	 */
	getGlobal() {
		return this.db.getGlobalToolsConfig();
	}

	/**
	 * Save the global tools configuration
	 */
	saveGlobal(config: ReturnType<typeof this.db.getGlobalToolsConfig>) {
		this.db.saveGlobalToolsConfig(config);
	}

	/**
	 * Get default tools configuration for new sessions based on global settings
	 *
	 * ARCHITECTURE (Direct 1:1 UI→SDK Mapping):
	 * - disabledMcpServers: List of server names to disable (empty = all enabled)
	 * - This is written to .claude/settings.local.json and SDK applies filtering
	 * - No intermediate loadProjectMcp/enabledMcpPatterns values needed
	 */
	getDefaultForNewSession(): Session['config']['tools'] {
		const globalToolsConfig = this.db.getGlobalToolsConfig();
		const globalSettings = this.settingsManager.getGlobalSettings();

		// Build disabledMcpServers from global mcpServerSettings
		// Servers with allowed=false or defaultOn=false are disabled by default
		const mcpServerSettings = globalSettings.mcpServerSettings || {};
		const mcpServers = this.settingsManager.listMcpServersFromSources();

		const disabledMcpServers: string[] = [];
		for (const source of Object.keys(mcpServers) as Array<'user' | 'project' | 'local'>) {
			for (const server of mcpServers[source]) {
				const settings = mcpServerSettings[server.name];
				const isAllowed = settings?.allowed !== false; // Default to true
				const isDefaultOn = settings?.defaultOn === true; // Default to false (matches UI)

				this.logger.info(
					`[ToolsConfigManager] Server ${server.name}: allowed=${isAllowed}, defaultOn=${isDefaultOn}`
				);

				// Add to disabled list if not allowed OR not defaultOn
				if (!isAllowed || !isDefaultOn) {
					disabledMcpServers.push(server.name);
				}
			}
		}

		this.logger.info(
			'[ToolsConfigManager] getDefaultForNewSession - disabledMcpServers:',
			disabledMcpServers
		);

		return {
			// System Prompt: Claude Code preset - Only enable if allowed AND default is on
			useClaudeCodePreset:
				globalToolsConfig.systemPrompt.claudeCodePreset.allowed &&
				globalToolsConfig.systemPrompt.claudeCodePreset.defaultEnabled,
			// Setting Sources: Use global setting sources
			settingSources: globalSettings.settingSources || ['user', 'project', 'local'],
			// MCP: Direct mapping - list of disabled servers (empty = all enabled)
			// SDK will auto-load from .mcp.json and apply this filter via settings.local.json
			disabledMcpServers,
			// Liuboer tools: Only enable if allowed AND default is on
			liuboerTools: {
				memory:
					globalToolsConfig.liuboerTools.memory.allowed &&
					globalToolsConfig.liuboerTools.memory.defaultEnabled,
			},
		};
	}
}
