/**
 * QueryOptionsBuilder - Builds SDK query options from session config
 *
 * Extracted from AgentSession.runQuery() to improve maintainability.
 * Handles all SDK options construction including:
 * - System prompt configuration (Claude Code preset + worktree isolation)
 * - Tool configuration (disallowed tools based on session config)
 * - Setting sources (project, local)
 * - MCP servers configuration
 * - Additional directories (worktree isolation)
 * - Hooks (output limiter)
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session, ThinkingLevel } from '@liuboer/shared';
import { THINKING_LEVEL_TOKENS } from '@liuboer/shared';
import type { SettingsManager } from '../settings-manager';
import { createOutputLimiterHook, getOutputLimiterConfigFromSettings } from './output-limiter-hook';
import { Logger } from '../logger';

export class QueryOptionsBuilder {
	private logger: Logger;

	constructor(
		private session: Session,
		private settingsManager: SettingsManager
	) {
		this.logger = new Logger(`QueryOptionsBuilder ${session.id}`);
	}

	/**
	 * Build complete SDK query options
	 */
	async build(): Promise<Options> {
		const toolsConfig = this.session.config.tools;

		// Get settings-derived options
		const sdkSettingsOptions = await this.getSettingsOptions();

		// Build all configuration components
		const systemPromptConfig = this.buildSystemPrompt();
		const disallowedTools = this.getDisallowedTools();
		const settingSources = this.getSettingSources();
		const additionalDirectories = this.getAdditionalDirectories();
		const hooks = this.buildHooks();

		// Build final query options
		// Settings-derived options first, then session-specific overrides
		const queryOptions: Options = {
			// Start with settings-derived options (from global settings)
			...sdkSettingsOptions,
			// Override with session-specific options (these take precedence)
			model: this.session.config.model,
			cwd: this.getCwd(),
			additionalDirectories,
			permissionMode: 'bypassPermissions',
			allowDangerouslySkipPermissions: true,
			maxTurns: Infinity,
			// In test/CI environments, disable setting sources (CLAUDE.md, .claude/settings.json)
			// to prevent subprocess crashes due to missing or misconfigured settings files.
			// This matches the title generation behavior which also uses empty settingSources.
			settingSources: process.env.NODE_ENV === 'test' ? [] : settingSources,
			systemPrompt: systemPromptConfig,
			disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
			// MCP servers: In test/CI environments, disable MCP to prevent subprocess crashes
			// due to missing MCP dependencies or configuration issues.
			// In production, allow auto-loading (undefined).
			mcpServers: process.env.NODE_ENV === 'test' ? {} : undefined,
			hooks,
		};

		// DEBUG: Log query options for verification
		const useClaudeCodePreset = toolsConfig?.useClaudeCodePreset ?? true;
		this.logger.log(`Query options:`, {
			model: queryOptions.model,
			useClaudeCodePreset,
			settingSources: queryOptions.settingSources,
			disallowedTools: queryOptions.disallowedTools,
			mcpServers: queryOptions.mcpServers === undefined ? 'auto-load' : 'disabled',
			additionalDirectories:
				queryOptions.additionalDirectories === undefined
					? 'unrestricted'
					: `restricted to cwd (${queryOptions.additionalDirectories.length} additional dirs)`,
			toolsConfig,
		});

		return queryOptions;
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
	 * When Claude Code preset is enabled: Use preset with optional worktree append
	 * When disabled: Use minimal system prompt (or undefined)
	 */
	private buildSystemPrompt(): Options['systemPrompt'] {
		const toolsConfig = this.session.config.tools;
		const useClaudeCodePreset = toolsConfig?.useClaudeCodePreset ?? true;

		if (useClaudeCodePreset) {
			const config: Options['systemPrompt'] = {
				type: 'preset',
				preset: 'claude_code',
			};

			// Append worktree isolation instructions if session uses a worktree
			if (this.session.worktree) {
				config.append = this.getWorktreeIsolationText();
			}

			return config;
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
	 * Strategy:
	 * - MCP tools: Controlled via file-based settings (not disallowedTools)
	 * - SDK built-in tools: Always enabled
	 * - Liuboer tools: Based on liuboerTools config
	 */
	private getDisallowedTools(): string[] {
		const toolsConfig = this.session.config.tools;
		const disallowedTools: string[] = [];

		// Disable Liuboer memory tool if not enabled
		if (!toolsConfig?.liuboerTools?.memory) {
			disallowedTools.push('liuboer__memory__*');
		}

		return disallowedTools;
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
	 */
	private buildHooks(): Options['hooks'] {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const outputLimiterConfig = getOutputLimiterConfigFromSettings(globalSettings);
		const outputLimiterHook = createOutputLimiterHook(outputLimiterConfig);

		return {
			PreToolUse: [{ hooks: [outputLimiterHook] }],
		};
	}
}
