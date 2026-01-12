/**
 * QueryOptionsBuilder - Builds SDK query options from session config
 *
 * Extracted from AgentSession.runQuery() to improve maintainability.
 * Handles all SDK options construction including:
 * - System prompt configuration (custom string or Claude Code preset)
 * - Tool configuration (tools preset, allowed/disallowed tools)
 * - Agents/subagents configuration
 * - Sandbox configuration
 * - MCP servers configuration
 * - Output format (JSON schema)
 * - Beta features
 * - Environment settings
 * - Setting sources (project, local)
 * - Additional directories (worktree isolation)
 * - Hooks (output limiter)
 */

import type { Options, CanUseTool } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session, ThinkingLevel, SystemPromptConfig, ClaudeCodePreset } from '@liuboer/shared';
import { THINKING_LEVEL_TOKENS } from '@liuboer/shared';
import type { PermissionMode } from '@liuboer/shared/types/settings';
import type { SettingsManager } from '../settings-manager';
import { createOutputLimiterHook, getOutputLimiterConfigFromSettings } from './output-limiter-hook';
import { Logger } from '../logger';
import { getProviderService } from '../provider-service';

export class QueryOptionsBuilder {
	private logger: Logger;
	private canUseTool?: CanUseTool;

	constructor(
		private session: Session,
		private settingsManager: SettingsManager
	) {
		this.logger = new Logger(`QueryOptionsBuilder ${session.id}`);
	}

	/**
	 * Set the canUseTool callback for handling tool permissions
	 * This is used for AskUserQuestion and other interactive tools
	 */
	setCanUseTool(callback: CanUseTool): void {
		this.canUseTool = callback;
	}

	/**
	 * Build complete SDK query options
	 *
	 * Maps all SessionConfig (which extends SDKConfig) options to SDK Options
	 */
	async build(): Promise<Options> {
		const config = this.session.config;
		const legacyToolsConfig = config.tools; // Legacy Liuboer-specific tools config

		// Get settings-derived options (from global settings)
		const sdkSettingsOptions = await this.getSettingsOptions();

		// Translate model ID for SDK compatibility
		// GLM model IDs (glm-4.7, glm-4.5-air) need to be mapped to SDK-recognized IDs
		// (default, haiku, opus) since the SDK only knows Anthropic model IDs
		const providerService = getProviderService();
		const sdkModelId = providerService.translateModelIdForSdk(config.model || 'default');
		const sdkFallbackModel = config.fallbackModel
			? providerService.translateModelIdForSdk(config.fallbackModel)
			: undefined;

		// Build all configuration components
		const systemPromptConfig = this.buildSystemPrompt();
		const disallowedTools = this.getDisallowedTools();
		const allowedTools = this.getAllowedTools();
		const settingSources = this.getSettingSources();
		const additionalDirectories = this.getAdditionalDirectories();
		const hooks = this.buildHooks();
		const permissionMode = this.getPermissionMode();
		const mcpServers = this.getMcpServers();
		const mergedEnv = this.getMergedEnvironmentVars();

		// Build final query options
		// Settings-derived options first, then session-specific overrides
		const queryOptions: Options = {
			// Start with settings-derived options (from global settings)
			...sdkSettingsOptions,

			// ============ Model & Execution ============
			model: sdkModelId,
			fallbackModel: sdkFallbackModel,
			maxTurns: config.maxTurns ?? Infinity,
			maxBudgetUsd: config.maxBudgetUsd,

			// ============ System Prompt ============
			systemPrompt: systemPromptConfig,

			// ============ Tools ============
			// sdkToolsPreset maps to SDK's tools option
			tools: config.sdkToolsPreset,
			allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
			disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,

			// ============ Agents/Subagents ============
			// Cast to SDK type - our AgentDefinition is compatible
			agents: config.agents as Options['agents'],

			// ============ Permissions ============
			permissionMode,
			allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',

			// ============ Sandbox ============
			// Cast to SDK type - our SandboxSettings is compatible
			sandbox: config.sandbox as Options['sandbox'],

			// ============ MCP Servers ============
			// Cast to SDK type - mcpServers uses compatible structure
			mcpServers: mcpServers as Options['mcpServers'],
			strictMcpConfig: config.strictMcpConfig,

			// ============ Output Format ============
			outputFormat: config.outputFormat,

			// ============ Plugins ============
			plugins: config.plugins,

			// ============ Beta Features ============
			betas: config.betas,

			// ============ Environment ============
			cwd: this.getCwd(),
			additionalDirectories,
			env: mergedEnv,
			executable: config.executable,
			executableArgs: config.executableArgs,

			// ============ Settings ============
			// In test/CI environments, disable setting sources (CLAUDE.md, .claude/settings.json)
			// to prevent subprocess crashes due to missing or misconfigured settings files.
			settingSources: process.env.NODE_ENV === 'test' ? [] : settingSources,

			// ============ Streaming ============
			includePartialMessages: config.includePartialMessages,

			// ============ Hooks ============
			hooks,

			// ============ Callbacks ============
			canUseTool: this.canUseTool,
		};

		// Remove undefined values to use SDK defaults
		const cleanedOptions = Object.fromEntries(
			Object.entries(queryOptions).filter(([_, v]) => v !== undefined)
		) as Options;

		// DEBUG: Log query options for verification
		const useClaudeCodePreset = legacyToolsConfig?.useClaudeCodePreset ?? true;
		this.logger.log(`Query options:`, {
			originalModel: config.model || 'default',
			sdkModel: cleanedOptions.model,
			fallbackModel: cleanedOptions.fallbackModel,
			maxTurns: cleanedOptions.maxTurns,
			maxBudgetUsd: cleanedOptions.maxBudgetUsd,
			permissionMode: cleanedOptions.permissionMode,
			allowDangerouslySkipPermissions: cleanedOptions.allowDangerouslySkipPermissions,
			useClaudeCodePreset,
			settingSources: cleanedOptions.settingSources,
			tools: cleanedOptions.tools,
			allowedTools: cleanedOptions.allowedTools,
			disallowedTools: cleanedOptions.disallowedTools,
			agents: cleanedOptions.agents ? Object.keys(cleanedOptions.agents) : undefined,
			sandbox: cleanedOptions.sandbox?.enabled,
			mcpServers:
				cleanedOptions.mcpServers === undefined
					? 'auto-load'
					: Object.keys(cleanedOptions.mcpServers),
			outputFormat: cleanedOptions.outputFormat?.type,
			betas: cleanedOptions.betas,
			additionalDirectories:
				cleanedOptions.additionalDirectories === undefined
					? 'unrestricted'
					: `restricted to cwd (${cleanedOptions.additionalDirectories.length} additional dirs)`,
			legacyToolsConfig,
		});

		return cleanedOptions;
	}

	/**
	 * Add resume and thinking tokens to options
	 * Called separately since these depend on session state at query time
	 */
	addSessionStateOptions(options: Options): Options {
		const result = { ...options };

		// Add resume parameter if SDK session ID exists (session resumption)
		if (this.session.sdkSessionId) {
			result.resume = this.session.sdkSessionId;
			this.logger.log(`Resuming SDK session: ${this.session.sdkSessionId}`);
		} else {
			this.logger.log(`Starting new SDK session`);
		}

		// Add thinking token budget based on thinkingLevel config
		const thinkingLevel = (this.session.config.thinkingLevel || 'auto') as ThinkingLevel;
		const maxThinkingTokens = THINKING_LEVEL_TOKENS[thinkingLevel];
		if (maxThinkingTokens !== undefined) {
			result.maxThinkingTokens = maxThinkingTokens;
			this.logger.log(`Extended thinking enabled: ${thinkingLevel} (${maxThinkingTokens} tokens)`);
		}

		return result;
	}

	/**
	 * Get the current working directory for the SDK
	 */
	getCwd(): string {
		return this.session.worktree ? this.session.worktree.worktreePath : this.session.workspacePath;
	}

	/**
	 * Build system prompt configuration
	 *
	 * Priority:
	 * 1. SDKConfig systemPrompt (from session.config.systemPrompt)
	 * 2. Legacy tools config (useClaudeCodePreset)
	 * 3. Default: Claude Code preset
	 *
	 * NOTE: In test environments, we skip the Claude Code preset to avoid subprocess
	 * crashes due to missing system resources or configuration.
	 */
	private buildSystemPrompt(): Options['systemPrompt'] {
		// In test environments, skip the system prompt entirely to match
		// the title generation configuration which works reliably.
		// The claude_code preset requires additional system resources
		// that may not be available on CI runners.
		if (process.env.NODE_ENV === 'test') {
			return undefined;
		}

		const config = this.session.config;

		// Priority 1: Check if SDKConfig systemPrompt is explicitly set
		if (config.systemPrompt !== undefined) {
			return this.buildCustomSystemPrompt(config.systemPrompt);
		}

		// Priority 2: Fall back to legacy tools config
		const legacyToolsConfig = config.tools;
		const useClaudeCodePreset = legacyToolsConfig?.useClaudeCodePreset ?? true;

		if (useClaudeCodePreset) {
			const presetConfig: Options['systemPrompt'] = {
				type: 'preset',
				preset: 'claude_code',
			};

			// Append worktree isolation instructions if session uses a worktree
			if (this.session.worktree) {
				presetConfig.append = this.getWorktreeIsolationText();
			}

			return presetConfig;
		}

		// No Claude Code preset - use minimal system prompt or undefined
		// When worktree is used, still append isolation instructions
		if (this.session.worktree) {
			return this.getMinimalWorktreePrompt();
		}

		// If no worktree, systemPromptConfig remains undefined (SDK default behavior)
		return undefined;
	}

	/**
	 * Build system prompt from SDKConfig systemPrompt
	 *
	 * Handles both custom string prompts and Claude Code preset configuration
	 */
	private buildCustomSystemPrompt(systemPrompt: SystemPromptConfig): Options['systemPrompt'] {
		// Custom string prompt
		if (typeof systemPrompt === 'string') {
			// Append worktree isolation if needed
			if (this.session.worktree) {
				return systemPrompt + '\n\n' + this.getWorktreeIsolationText();
			}
			return systemPrompt;
		}

		// Claude Code preset configuration
		if (systemPrompt.type === 'preset' && systemPrompt.preset === 'claude_code') {
			const presetConfig: ClaudeCodePreset = {
				type: 'preset',
				preset: 'claude_code',
			};

			// Combine existing append with worktree isolation
			let append = systemPrompt.append || '';
			if (this.session.worktree) {
				if (append) {
					append += '\n\n';
				}
				append += this.getWorktreeIsolationText();
			}

			if (append) {
				presetConfig.append = append;
			}

			return presetConfig;
		}

		// Unknown format - return as-is
		return undefined;
	}

	/**
	 * Get worktree isolation text to append to system prompt
	 */
	private getWorktreeIsolationText(): string {
		const wt = this.session.worktree!;
		return `
IMPORTANT: Git Worktree Isolation

This session is running in an isolated git worktree at:
${wt.worktreePath}

Branch: ${wt.branch}
Main repository: ${wt.mainRepoPath}

CRITICAL RULES:
1. ALL file operations MUST stay within the worktree directory: ${wt.worktreePath}
2. NEVER modify files in the main repository at: ${wt.mainRepoPath}
3. Your current working directory (cwd) is already set to the worktree path
4. Do NOT attempt to access or modify files outside the worktree path

ALLOWED GIT OPERATIONS ON ROOT REPOSITORY:
To merge changes from this session branch into the main branch of the root repository:

git --git-dir=${wt.mainRepoPath}/.git --work-tree=${wt.mainRepoPath} merge ${wt.branch}

To push the main branch to remote:

git --git-dir=${wt.mainRepoPath}/.git --work-tree=${wt.mainRepoPath} push origin main

These commands operate on the root repository without violating worktree isolation.
This isolation ensures concurrent sessions don't conflict with each other.
`.trim();
	}

	/**
	 * Get minimal worktree prompt (when Claude Code preset is disabled)
	 */
	private getMinimalWorktreePrompt(): string {
		const wt = this.session.worktree!;
		return `
You are an AI assistant helping with coding tasks.

IMPORTANT: Git Worktree Isolation

This session is running in an isolated git worktree at:
${wt.worktreePath}

Branch: ${wt.branch}
Main repository: ${wt.mainRepoPath}

CRITICAL RULES:
1. ALL file operations MUST stay within the worktree directory: ${wt.worktreePath}
2. NEVER modify files in the main repository at: ${wt.mainRepoPath}
3. Your current working directory (cwd) is already set to the worktree path
`.trim();
	}

	/**
	 * Get list of disallowed tools based on session config
	 *
	 * Combines:
	 * 1. SDKConfig disallowedTools (explicit tools to disable)
	 * 2. Legacy liuboerTools config (memory tool control)
	 */
	private getDisallowedTools(): string[] {
		const config = this.session.config;
		const disallowedTools: string[] = [];

		// Add SDKConfig disallowedTools
		if (config.disallowedTools && config.disallowedTools.length > 0) {
			disallowedTools.push(...config.disallowedTools);
		}

		// Legacy: Disable Liuboer memory tool if not enabled
		const legacyToolsConfig = config.tools;
		if (!legacyToolsConfig?.liuboerTools?.memory) {
			disallowedTools.push('liuboer__memory__*');
		}

		// Deduplicate
		return [...new Set(disallowedTools)];
	}

	/**
	 * Get list of allowed tools based on session config
	 *
	 * These tools will be auto-approved without permission prompts
	 */
	private getAllowedTools(): string[] {
		const config = this.session.config;

		if (config.allowedTools && config.allowedTools.length > 0) {
			return [...config.allowedTools];
		}

		return [];
	}

	/**
	 * Get MCP servers configuration
	 *
	 * Priority:
	 * 1. SDKConfig mcpServers (programmatic configuration)
	 * 2. Undefined to let SDK auto-load from settings files
	 *
	 * In test/CI environments, disable MCP to prevent subprocess crashes
	 */
	private getMcpServers(): Record<string, unknown> | undefined {
		// In test/CI environments, disable MCP
		if (process.env.NODE_ENV === 'test') {
			return {};
		}

		// Use SDKConfig mcpServers if explicitly set
		const config = this.session.config;
		if (config.mcpServers !== undefined) {
			return config.mcpServers;
		}

		// Let SDK auto-load from settings files
		return undefined;
	}

	/**
	 * Get setting sources configuration
	 *
	 * Controls CLAUDE.md and .claude/settings.json loading
	 */
	private getSettingSources(): Options['settingSources'] {
		const toolsConfig = this.session.config.tools;
		const loadSettingSources = toolsConfig?.loadSettingSources ?? true;
		return loadSettingSources ? ['project', 'local'] : ['local'];
	}

	/**
	 * Get additional directories configuration
	 *
	 * For worktree sessions: Restrict to cwd only (strict isolation)
	 * For non-worktree: Leave undefined for backward compatibility
	 */
	private getAdditionalDirectories(): string[] | undefined {
		return this.session.worktree ? [] : undefined;
	}

	/**
	 * Get merged environment variables for SDK subprocess
	 *
	 * IMPORTANT: Provider env vars (GLM, etc.) are now applied to process.env
	 * before SDK query creation, NOT passed via options.env.
	 *
	 * This method only returns session-specific env vars from session.config.env.
	 * Provider vars are handled by applyEnvVarsToProcess() in AgentSession.
	 *
	 * @returns Session env vars only (provider vars applied separately)
	 */
	private getMergedEnvironmentVars(): Record<string, string> | undefined {
		const sessionEnv = this.session.config.env;

		// If no session env, return undefined
		if (!sessionEnv || Object.keys(sessionEnv).length === 0) {
			return undefined;
		}

		// Return session env vars only
		const mergedEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(sessionEnv)) {
			if (value !== undefined) {
				mergedEnv[key] = value;
			}
		}

		return Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined;
	}

	/**
	 * Get permission mode with 2-layer priority system
	 *
	 * Priority:
	 * 1. Session config (highest priority)
	 * 2. Global settings
	 * 3. Default: 'bypassPermissions' (production) or 'acceptEdits' (test/CI)
	 *
	 * In test/CI environments (NODE_ENV=test), 'default' and final fallback
	 * resolve to 'acceptEdits' to avoid SDK subprocess crashes when running as root.
	 *
	 * @returns Permission mode for SDK operations
	 */
	private getPermissionMode(): PermissionMode {
		// Layer 1: Session config (highest priority)
		if (this.session.config.permissionMode) {
			// Map 'default' based on environment
			if (this.session.config.permissionMode === 'default') {
				// In test/CI environments, use 'acceptEdits' to avoid root user crashes
				// (bypassPermissions crashes SDK subprocess when running as root)
				return process.env.NODE_ENV === 'test' ? 'acceptEdits' : 'bypassPermissions';
			}
			return this.session.config.permissionMode;
		}

		// Layer 2: Global settings
		const globalSettings = this.settingsManager.getGlobalSettings();
		if (globalSettings.permissionMode) {
			// Map 'default' based on environment
			if (globalSettings.permissionMode === 'default') {
				// In test/CI environments, use 'acceptEdits' to avoid root user crashes
				return process.env.NODE_ENV === 'test' ? 'acceptEdits' : 'bypassPermissions';
			}
			return globalSettings.permissionMode;
		}

		// Layer 3: Default (environment-aware)
		// In test/CI environments, use 'acceptEdits' to avoid root user crashes
		return process.env.NODE_ENV === 'test' ? 'acceptEdits' : 'bypassPermissions';
	}

	/**
	 * Get SDK options from global settings
	 *
	 * This writes file-only settings to .claude/settings.local.json and returns
	 * SDK-supported options to merge with query options
	 */
	private async getSettingsOptions(): Promise<Partial<Options>> {
		const toolsConfig = this.session.config.tools;
		return await this.settingsManager.prepareSDKOptions({
			disabledMcpServers: toolsConfig?.disabledMcpServers ?? [],
		});
	}

	/**
	 * Build hooks configuration
	 *
	 * Currently includes output limiter hook to prevent "prompt too long" errors
	 *
	 * NOTE: In test environments, skip hooks to match title generation
	 * configuration which works reliably.
	 */
	private buildHooks(): Options['hooks'] {
		// Skip hooks in test environments to avoid potential subprocess crashes
		if (process.env.NODE_ENV === 'test') {
			return undefined;
		}

		const globalSettings = this.settingsManager.getGlobalSettings();
		const outputLimiterConfig = getOutputLimiterConfigFromSettings(globalSettings);
		const outputLimiterHook = createOutputLimiterHook(outputLimiterConfig);

		return {
			PreToolUse: [{ hooks: [outputLimiterHook] }],
		};
	}
}
