/**
 * Settings Manager
 *
 * Manages global and session-specific settings with a hybrid approach:
 * - SDK-supported settings are passed as query() options
 * - File-only settings are written to .claude/settings.local.json
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { GlobalSettings, SessionSettings, SettingSource } from '@neokai/shared';

/**
 * MCP server info from a setting source
 */
export interface McpServerInfo {
	name: string;
	source: SettingSource;
	command?: string;
	args?: string[];
}
import type { Database } from '../storage/database';
import { Logger } from './logger';

export class SettingsManager {
	private logger = new Logger('SettingsManager');

	constructor(
		private db: Database,
		private workspacePath: string
	) {}

	/**
	 * Get current global settings
	 */
	getGlobalSettings(): GlobalSettings {
		return this.db.getGlobalSettings();
	}

	/**
	 * Update global settings (partial update)
	 */
	updateGlobalSettings(updates: Partial<GlobalSettings>): GlobalSettings {
		return this.db.updateGlobalSettings(updates);
	}

	/**
	 * Save global settings (full replace)
	 */
	saveGlobalSettings(settings: GlobalSettings): void {
		this.db.saveGlobalSettings(settings);
	}

	/**
	 * Prepare SDK options for a session
	 *
	 * This is the critical method that:
	 * 1. Merges global settings with session overrides
	 * 2. Writes file-only settings to .claude/settings.local.json BEFORE SDK starts
	 * 3. Returns SDK-supported options for query()
	 *
	 * @param sessionOverrides - Session-specific setting overrides
	 * @returns SDK options object for query()
	 */
	async prepareSDKOptions(
		sessionOverrides?: Partial<SessionSettings>
	): Promise<Record<string, unknown>> {
		const globalSettings = this.getGlobalSettings();
		const mergedSettings = { ...globalSettings, ...sessionOverrides };

		// 1. Write file-only settings BEFORE SDK starts
		// This ensures .claude/settings.local.json is ready when SDK initializes
		await this.writeFileOnlySettings(mergedSettings);

		// 2. Extract and return SDK-supported options
		return this.extractSDKOptions(mergedSettings);
	}

	/**
	 * Extract SDK-supported options from settings
	 *
	 * These settings can be passed directly to the SDK query() function.
	 */
	private extractSDKOptions(settings: GlobalSettings): Record<string, unknown> {
		const sdkOptions: Record<string, unknown> = {
			settingSources: settings.settingSources,
		};

		// Model
		if (settings.model) {
			sdkOptions.model = settings.model;
		}

		// Permissions
		if (settings.permissionMode) {
			sdkOptions.permissionMode = settings.permissionMode;
		}
		if (settings.allowedTools) {
			sdkOptions.allowedTools = settings.allowedTools;
		}
		if (settings.disallowedTools) {
			sdkOptions.disallowedTools = settings.disallowedTools;
		}
		if (settings.additionalDirectories) {
			sdkOptions.additionalDirectories = settings.additionalDirectories;
		}

		// Thinking
		if (settings.maxThinkingTokens !== undefined) {
			// null means disabled, so pass undefined to SDK
			sdkOptions.maxThinkingTokens = settings.maxThinkingTokens ?? undefined;
		}

		// Environment
		if (settings.env) {
			sdkOptions.env = settings.env;
		}

		// Limits
		if (settings.maxTurns) {
			sdkOptions.maxTurns = settings.maxTurns;
		}
		if (settings.maxBudgetUsd) {
			sdkOptions.maxBudgetUsd = settings.maxBudgetUsd;
		}

		// Sandbox
		if (settings.sandbox) {
			sdkOptions.sandbox = {
				enabled: settings.sandbox.enabled,
				autoAllowBashIfSandboxed: settings.sandbox.autoAllowBashIfSandboxed,
				network: settings.sandbox.network,
			};
		}

		// Betas
		if (settings.betas) {
			sdkOptions.betas = settings.betas;
		}

		// System prompt
		if (settings.systemPrompt) {
			sdkOptions.systemPrompt = settings.systemPrompt;
		}

		return sdkOptions;
	}

	/**
	 * Read attribution from user settings (~/.claude/settings.json)
	 * Returns undefined if not found or if there's an error reading the file
	 */
	private readUserAttribution(): { commit?: string; pr?: string } | undefined {
		// Support TEST_USER_SETTINGS_DIR for isolated testing
		const baseDir = process.env.TEST_USER_SETTINGS_DIR || join(homedir(), '.claude');
		const userSettingsPath = join(baseDir, 'settings.json');

		try {
			if (!existsSync(userSettingsPath)) {
				return undefined;
			}
			const content = readFileSync(userSettingsPath, 'utf-8');
			const userSettings = JSON.parse(content) as Record<string, unknown>;
			return userSettings.attribution as { commit?: string; pr?: string } | undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Write file-only settings to .claude/settings.local.json
	 *
	 * These settings have no SDK option equivalent and must be written
	 * to the settings file for the SDK to pick them up.
	 */
	private async writeFileOnlySettings(settings: GlobalSettings): Promise<void> {
		const settingsLocalPath = join(this.workspacePath, '.claude/settings.local.json');

		// Read existing settings (preserve non-NeoKai settings)
		let localSettings: Record<string, unknown> = {};
		try {
			if (existsSync(settingsLocalPath)) {
				const content = readFileSync(settingsLocalPath, 'utf-8');
				localSettings = JSON.parse(content) as Record<string, unknown>;
			}
		} catch {
			// Continue with empty object
		}

		// Update NeoKai-managed settings

		// MCP Server Control (CRITICAL)
		if (settings.disabledMcpServers !== undefined) {
			localSettings.disabledMcpjsonServers = settings.disabledMcpServers;
		}
		if (settings.enabledMcpServers !== undefined) {
			localSettings.enabledMcpjsonServers = settings.enabledMcpServers;
		}
		if (settings.enableAllProjectMcpServers !== undefined) {
			localSettings.enableAllProjectMcpServers = settings.enableAllProjectMcpServers;
		}

		// Permissions (file-only features)
		if (settings.askPermissions !== undefined) {
			localSettings.permissions = {
				...(localSettings.permissions as Record<string, unknown>),
				ask: settings.askPermissions,
			};
		}

		// Sandbox (file-only features)
		if (
			settings.excludedCommands !== undefined ||
			settings.allowUnsandboxedCommands !== undefined
		) {
			localSettings.sandbox = {
				...(localSettings.sandbox as Record<string, unknown>),
			};
			if (settings.excludedCommands !== undefined) {
				(localSettings.sandbox as Record<string, unknown>).excludedCommands =
					settings.excludedCommands;
			}
			if (settings.allowUnsandboxedCommands !== undefined) {
				(localSettings.sandbox as Record<string, unknown>).allowUnsandboxedCommands =
					settings.allowUnsandboxedCommands;
			}
		}

		// UI/Display
		if (settings.outputStyle !== undefined) {
			localSettings.outputStyle = settings.outputStyle;
		}

		// Attribution
		// WORKAROUND: SDK has a bug where attribution settings don't properly cascade
		// from user settings to local settings. To ensure user-level attribution preferences
		// are respected, we explicitly read from user settings and write to local settings.
		// See: https://github.com/anthropics/claude-code/issues/11135
		if (settings.attribution !== undefined) {
			// User has configured attribution in NeoKai's database, use it
			localSettings.attribution = settings.attribution;
		} else if (localSettings.attribution === undefined) {
			// No attribution in database AND no existing attribution in local file,
			// fall back to user settings to work around SDK bug
			const userAttribution = this.readUserAttribution();
			if (userAttribution !== undefined) {
				localSettings.attribution = userAttribution;
			}
		}
		// If localSettings.attribution is already set, preserve it

		// Ensure directory exists
		mkdirSync(dirname(settingsLocalPath), { recursive: true });

		// Write back
		writeFileSync(settingsLocalPath, JSON.stringify(localSettings, null, 2));
	}

	/**
	 * Read current file-only settings from .claude/settings.local.json
	 *
	 * This is useful for syncing UI state with file state.
	 */
	readFileOnlySettings(): Partial<GlobalSettings> {
		const settingsLocalPath = join(this.workspacePath, '.claude/settings.local.json');

		try {
			if (!existsSync(settingsLocalPath)) {
				return {};
			}

			const content = readFileSync(settingsLocalPath, 'utf-8');
			const localSettings = JSON.parse(content) as Record<string, unknown>;

			return {
				disabledMcpServers: (localSettings.disabledMcpjsonServers as string[]) || [],
				enabledMcpServers: (localSettings.enabledMcpjsonServers as string[]) || undefined,
				enableAllProjectMcpServers:
					(localSettings.enableAllProjectMcpServers as boolean) || undefined,
				askPermissions:
					((localSettings.permissions as Record<string, unknown>)?.ask as string[]) || undefined,
				excludedCommands:
					((localSettings.sandbox as Record<string, unknown>)?.excludedCommands as string[]) ||
					undefined,
				outputStyle: (localSettings.outputStyle as string) || undefined,
				attribution: (localSettings.attribution as { commit?: string; pr?: string }) || undefined,
			};
		} catch {
			return {};
		}
	}

	/**
	 * Toggle MCP server enabled/disabled state
	 *
	 * This updates both the database and the .claude/settings.local.json file.
	 */
	async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
		const currentSettings = this.getGlobalSettings();
		const currentDisabled = currentSettings.disabledMcpServers || [];

		let updatedDisabled: string[];
		if (enabled) {
			// Remove from disabled list
			updatedDisabled = currentDisabled.filter((s) => s !== serverName);
		} else {
			// Add to disabled list (if not already there)
			if (!currentDisabled.includes(serverName)) {
				updatedDisabled = [...currentDisabled, serverName];
			} else {
				updatedDisabled = currentDisabled;
			}
		}

		// Update database
		const updatedSettings = this.updateGlobalSettings({
			disabledMcpServers: updatedDisabled,
		});

		// Write to file immediately for next SDK query
		await this.writeFileOnlySettings(updatedSettings);
	}

	/**
	 * Get list of disabled MCP servers
	 */
	getDisabledMcpServers(): string[] {
		const settings = this.getGlobalSettings();
		return settings.disabledMcpServers || [];
	}

	/**
	 * Set list of disabled MCP servers
	 */
	async setDisabledMcpServers(disabledServers: string[]): Promise<void> {
		const updatedSettings = this.updateGlobalSettings({
			disabledMcpServers: disabledServers,
		});

		// Write to file immediately
		await this.writeFileOnlySettings(updatedSettings);
	}

	/**
	 * List MCP servers from all enabled setting sources
	 *
	 * Reads MCP server configurations from:
	 * - User: ~/.claude/settings.json
	 * - Project: .claude/settings.json in workspace
	 * - Local: .claude/settings.local.json in workspace
	 *
	 * Only returns servers from sources that are enabled in global settings.
	 */
	listMcpServersFromSources(): Record<SettingSource, McpServerInfo[]> {
		const globalSettings = this.getGlobalSettings();
		const enabledSources = globalSettings.settingSources || ['user', 'project', 'local'];

		const result: Record<SettingSource, McpServerInfo[]> = {
			user: [],
			project: [],
			local: [],
		};

		// Helper to read MCP servers from a settings file
		const readMcpServers = (filePath: string, source: SettingSource): McpServerInfo[] => {
			try {
				if (!existsSync(filePath)) {
					return [];
				}
				const content = readFileSync(filePath, 'utf-8');
				const settings = JSON.parse(content) as Record<string, unknown>;

				// MCP servers can be in mcpServers object
				const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
				if (!mcpServers || typeof mcpServers !== 'object') {
					return [];
				}

				return Object.entries(mcpServers).map(([name, config]) => {
					const serverConfig = config as Record<string, unknown> | undefined;
					return {
						name,
						source,
						command: serverConfig?.command as string | undefined,
						args: serverConfig?.args as string[] | undefined,
					};
				});
			} catch {
				return [];
			}
		};

		// Read from each enabled source
		if (enabledSources.includes('user')) {
			// Support TEST_USER_SETTINGS_DIR for isolated testing
			const userBaseDir = process.env.TEST_USER_SETTINGS_DIR || join(homedir(), '.claude');
			const userSettingsPath = join(userBaseDir, 'settings.json');
			result.user = readMcpServers(userSettingsPath, 'user');
			// Also check user-level .mcp.json
			const userMcpDir = process.env.TEST_USER_SETTINGS_DIR || homedir();
			const userMcpPath = join(userMcpDir, '.mcp.json');
			result.user.push(...readMcpServers(userMcpPath, 'user'));
		}

		if (enabledSources.includes('project')) {
			const projectSettingsPath = join(this.workspacePath, '.claude', 'settings.json');
			result.project = readMcpServers(projectSettingsPath, 'project');
			// Also check project-level .mcp.json (Claude Code standard location)
			const projectMcpPath = join(this.workspacePath, '.mcp.json');
			result.project.push(...readMcpServers(projectMcpPath, 'project'));
		}

		if (enabledSources.includes('local')) {
			const localSettingsPath = join(this.workspacePath, '.claude', 'settings.local.json');
			result.local = readMcpServers(localSettingsPath, 'local');
		}

		return result;
	}

	/**
	 * Update MCP server settings (allowed/defaultOn)
	 *
	 * Stores per-server settings in GlobalSettings.mcpServerSettings
	 */
	updateMcpServerSettings(
		serverName: string,
		settings: { allowed?: boolean; defaultOn?: boolean }
	): void {
		const globalSettings = this.getGlobalSettings();
		const mcpServerSettings = globalSettings.mcpServerSettings || {};

		mcpServerSettings[serverName] = {
			...mcpServerSettings[serverName],
			...settings,
		};

		this.updateGlobalSettings({ mcpServerSettings });
	}

	/**
	 * Get MCP server settings (allowed/defaultOn)
	 */
	getMcpServerSettings(): Record<string, { allowed?: boolean; defaultOn?: boolean }> {
		const globalSettings = this.getGlobalSettings();
		return globalSettings.mcpServerSettings || {};
	}
}
