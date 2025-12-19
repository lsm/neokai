/**
 * Settings types for Liuboer
 *
 * This module defines the settings system types that support both SDK-native
 * settings (passed as query options) and file-only settings (written to
 * .claude/settings.local.json).
 */

export type SettingSource = 'user' | 'project' | 'local';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';

/**
 * Settings that can be passed to the SDK via query options
 */
export interface SDKSupportedSettings {
	// Model
	model?: string;

	// Permissions
	permissionMode?: PermissionMode;
	allowedTools?: string[];
	disallowedTools?: string[];
	additionalDirectories?: string[];

	// Thinking
	maxThinkingTokens?: number | null;

	// Environment
	env?: Record<string, string>;

	// Limits
	maxTurns?: number;
	maxBudgetUsd?: number;

	// Sandbox
	sandbox?: {
		enabled?: boolean;
		autoAllowBashIfSandboxed?: boolean;
		network?: {
			allowUnixSockets?: string[];
			allowLocalBinding?: boolean;
		};
	};

	// Betas
	betas?: Array<'context-1m-2025-08-07'>;

	// System prompt
	systemPrompt?: string;
}

/**
 * Settings that can only be configured via .claude/settings.local.json
 * These settings have no SDK option equivalent.
 */
export interface FileOnlySettings {
	// MCP Server Control (CRITICAL for Liuboer)
	disabledMcpServers?: string[];
	enabledMcpServers?: string[];
	enableAllProjectMcpServers?: boolean;

	// Permissions (file-only features)
	askPermissions?: string[];

	// Sandbox (file-only features)
	excludedCommands?: string[];
	allowUnsandboxedCommands?: boolean;

	// UI/Display
	outputStyle?: string;

	// Attribution
	attribution?: {
		commit?: string;
		pr?: string;
	};
}

/**
 * Per-server MCP settings (allowed/defaultOn)
 */
export interface McpServerSettings {
	allowed?: boolean;
	defaultOn?: boolean;
}

/**
 * Global settings that apply across all sessions
 */
export interface GlobalSettings extends SDKSupportedSettings, FileOnlySettings {
	// Setting sources to load (all enabled by default)
	settingSources: SettingSource[];

	// Per-server MCP settings (keyed by server name)
	mcpServerSettings?: Record<string, McpServerSettings>;
}

/**
 * Session-specific settings that can override global settings
 */
export interface SessionSettings extends GlobalSettings {
	sessionId: string;
}

/**
 * Default global settings
 */
export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	settingSources: ['user', 'project', 'local'],
	permissionMode: 'default',
	disabledMcpServers: [],
};

/**
 * MCP server information
 */
export interface McpServerInfo {
	name: string;
	status: 'connected' | 'failed' | 'pending' | 'disabled';
	enabled: boolean;
	description?: string;
}
