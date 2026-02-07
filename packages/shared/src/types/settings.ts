/**
 * Settings types for NeoKai
 *
 * This module defines the settings system types that support both SDK-native
 * settings (passed as query options) and file-only settings (written to
 * .claude/settings.local.json).
 */

import type { ThinkingLevel } from '../types.ts';

export type SettingSource = 'user' | 'project' | 'local';

export type PermissionMode =
	| 'default'
	| 'acceptEdits'
	| 'bypassPermissions'
	| 'plan'
	| 'delegate'
	| 'dontAsk';

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
		excludedCommands?: string[];
		allowUnsandboxedCommands?: boolean;
		network?: {
			allowUnixSockets?: string[];
			allowLocalBinding?: boolean;
			allowedDomains?: string[];
			allowAllUnixSockets?: boolean;
			httpProxyPort?: number;
			socksProxyPort?: number;
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
	// MCP Server Control (CRITICAL for NeoKai)
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
	showArchived?: boolean;

	// Attribution
	attribution?: {
		commit?: string;
		pr?: string;
	};

	// Output Limiter (NeoKai-specific)
	outputLimiter?: {
		enabled?: boolean;
		bash?: {
			headLines?: number; // First N lines to show (default: 100)
			tailLines?: number; // Last N lines to show (default: 200)
		};
		read?: {
			maxChars?: number; // Max characters to read (default: 50000)
		};
		grep?: {
			maxMatches?: number; // Max search matches (default: 500)
		};
		glob?: {
			maxFiles?: number; // Max files to list (default: 1000)
		};
		excludeTools?: string[]; // Tools to exclude from limiting
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

	// Default thinking level for new sessions
	// Maps to maxThinkingTokens in SDK options
	thinkingLevel?: ThinkingLevel;

	// Default auto-scroll setting for new sessions
	autoScroll?: boolean;

	// Default coordinator mode for new sessions
	coordinatorMode?: boolean;
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
	model: 'sonnet', // Default model for new sessions
	disabledMcpServers: [],
	showArchived: false,
	// Default auto-scroll to true so new sessions inherit this setting
	// This must match the display default in GlobalSettingsEditor (autoScroll ?? true)
	autoScroll: true,
	// Default coordinator mode to false (user opts in when needed)
	coordinatorMode: false,
	// Sandbox: Enable with balanced network permissions for development
	// Provides filesystem isolation while allowing common development operations
	sandbox: {
		enabled: true,
		autoAllowBashIfSandboxed: true,
		excludedCommands: ['git'], // Git runs outside sandbox for SSH, submodules, LFS, various git hosts
		network: {
			// Allow outbound network to common development domains (git, npm, pip, etc.)
			allowedDomains: [
				'github.com', '*.github.com', 'gist.github.com',
				'*.npmjs.org', 'registry.npmjs.org',
				'*.yarnpkg.com', 'registry.yarnpkg.com',
				'packages.gitlab.com',
				'*.pkg.dev', 'go.dev',
				'crates.io',
				'pypi.org', '*.pypi.org',
				'rubygems.org', '*.rubygems.org',
				'*.maven.org', '*.gradle.org',
				'cdn.jsdelivr.net',
				'*.cloudflare.com',
			],
			// Allow binding to localhost for dev servers (vite, webpack, etc.)
			allowLocalBinding: true,
			// Allow SSH agent and other Unix sockets
			allowAllUnixSockets: true,
		},
	},
	outputLimiter: {
		enabled: true,
		bash: {
			headLines: 100,
			tailLines: 200,
		},
		read: {
			maxChars: 50000,
		},
		grep: {
			maxMatches: 500,
		},
		glob: {
			maxFiles: 1000,
		},
		excludeTools: [],
	},
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
