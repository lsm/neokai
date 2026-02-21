/**
 * QueryOptionsBuilder - Builds SDK query options from session config
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
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
import type {
	Session,
	ThinkingLevel,
	ThinkingConfig,
	SystemPromptConfig,
	ClaudeCodePreset,
	AgentDefinition,
} from '@neokai/shared';
import { getCoordinatorAgents } from './coordinator-agents';
import { THINKING_LEVEL_TOKENS } from '@neokai/shared';
import type { PermissionMode } from '@neokai/shared/types/settings';
import type { SettingsManager } from '../settings-manager';
import { Logger } from '../logger';
import { getProviderContextManager } from '../providers/factory.js';
import { resolveSDKCliPath, isBundledBinary } from './sdk-cli-resolver.js';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Context interface - what QueryOptionsBuilder needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface QueryOptionsBuilderContext {
	readonly session: Session;
	readonly settingsManager: SettingsManager;
}

export class QueryOptionsBuilder {
	private logger: Logger;
	private canUseTool?: CanUseTool;

	constructor(private ctx: QueryOptionsBuilderContext) {
		this.logger = new Logger(`QueryOptionsBuilder ${ctx.session.id}`);
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
		const config = this.ctx.session.config;
		const _legacyToolsConfig = config.tools; // Legacy NeoKai-specific tools config

		// Get settings-derived options (from global settings)
		const sdkSettingsOptions = await this.getSettingsOptions();

		// Translate model ID for SDK compatibility using provider context
		// FIX: Recreate context each time to pick up model changes from model switching
		// GLM model IDs (glm-5, glm-4.5-air) need to be mapped to SDK-recognized IDs
		// (default, haiku, opus) since the SDK only knows Anthropic model IDs
		const contextManager = getProviderContextManager();
		const providerContext = contextManager.createContext(this.ctx.session);
		const sdkModelId = providerContext.getSdkModelId();
		let sdkFallbackModel: string | undefined;
		if (config.fallbackModel) {
			// For fallback model, we need to create a separate context
			const contextManager = getProviderContextManager();
			// Create a temporary session config with the fallback model
			const fallbackSession = {
				...this.ctx.session,
				config: { ...this.ctx.session.config, model: config.fallbackModel },
			};
			const fallbackContext = contextManager.createContext(fallbackSession);
			sdkFallbackModel = fallbackContext.getSdkModelId();
		}

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
		const sdkCliPath = this.getSDKCliPath();

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

			// ============ Process Spawning Hook ============
			// Used for testing to track SDK subprocess PID
			spawnClaudeCodeProcess: config.spawnClaudeCodeProcess,

			// ============ System Prompt ============
			systemPrompt: systemPromptConfig,

			// ============ Tools ============
			// sdkToolsPreset maps to SDK's tools option
			tools: config.sdkToolsPreset,
			allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
			disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,

			// ============ Agents/Subagents ============
			// agent: named agent for main thread (coordinator mode sets this)
			agent: config.agent,
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
			// In bundled binaries, process.execPath is the binary itself, not a JS runtime.
			// Default to 'bun' so the SDK finds the runtime from PATH.
			executable: config.executable ?? (isBundledBinary() ? 'bun' : undefined),
			executableArgs: config.executableArgs,
			pathToClaudeCodeExecutable: sdkCliPath,

			// ============ Settings ============
			settingSources,

			// ============ Streaming ============
			includePartialMessages: config.includePartialMessages,

			// ============ File Checkpointing ============
			// Enable file change tracking for rewind capability
			// Default to true unless explicitly disabled
			enableFileCheckpointing: config.enableFileCheckpointing ?? true,

			// ============ Hooks ============
			hooks,

			// ============ Callbacks ============
			canUseTool: this.canUseTool,
		};

		// ============ Room Session Restrictions ============
		// Room agents are orchestrators only — they must not have access to built-in
		// file/shell tools or user-configured MCP servers (e.g. chrome-devtools).
		if (this.ctx.session.type === 'room') {
			const builtinTools = [
				'Task',
				'TaskOutput',
				'TaskStop',
				'Bash',
				'Read',
				'Edit',
				'Write',
				'Glob',
				'Grep',
				'NotebookEdit',
				'WebFetch',
				'WebSearch',
				'TodoWrite',
				'AskUserQuestion',
				'EnterPlanMode',
				'ExitPlanMode',
				'Skill',
				'ToolSearch',
			];
			queryOptions.disallowedTools = [
				...new Set([...(queryOptions.disallowedTools ?? []), ...builtinTools]),
			];
			// Prevent user-configured MCP servers (from ~/.claude/settings.json) from
			// being merged in — the room agent only needs its own room-agent-tools MCP.
			queryOptions.strictMcpConfig = true;
			// Skip settings file loading so user's settings.json doesn't inject extra tools.
			queryOptions.settingSources = [];
		}

		// ============ Coordinator Mode ============
		// When coordinator mode is enabled, apply the coordinator agent to the main thread
		// and merge specialist agents with any user-defined agents
		if (config.coordinatorMode) {
			queryOptions.agent = 'Coordinator';
			const agents = getCoordinatorAgents(
				config.agents as Record<string, AgentDefinition> | undefined
			);

			// Inject worktree isolation into specialist agents that modify files.
			// The coordinator doesn't need it (it doesn't touch files), but subagents
			// run as separate CLI processes that don't inherit the parent's systemPrompt.append.
			if (this.ctx.session.worktree) {
				const worktreeText = this.getWorktreeIsolationText();
				for (const [name, agent] of Object.entries(agents)) {
					if (name === 'Coordinator') continue;
					agents[name] = {
						...agent,
						prompt: agent.prompt + '\n\n' + worktreeText,
					};
				}
			}

			queryOptions.agents = agents as Options['agents'];

			// Allow all tools at session level so sub-agents can use them under dontAsk
			const allTools = [
				'Task',
				'TaskOutput',
				'TaskStop',
				'Bash',
				'Read',
				'Edit',
				'Write',
				'Glob',
				'Grep',
				'NotebookEdit',
				'WebFetch',
				'WebSearch',
				'TodoWrite',
				'AskUserQuestion',
				'EnterPlanMode',
				'ExitPlanMode',
				'Skill',
				'ToolSearch',
			];
			const existing = queryOptions.allowedTools ?? [];
			queryOptions.allowedTools = [...new Set([...existing, ...allTools])];
		}

		// Remove undefined values to use SDK defaults
		const cleanedOptions = Object.fromEntries(
			Object.entries(queryOptions).filter(([_, v]) => v !== undefined)
		) as Options;

		return cleanedOptions;
	}

	/**
	 * Convert ThinkingLevel enum to new thinking option
	 * Maps the UI-friendly enum to SDK's new thinking API
	 */
	private thinkingLevelToThinkingConfig(level: ThinkingLevel): ThinkingConfig {
		const tokens = THINKING_LEVEL_TOKENS[level];

		if (tokens === undefined) {
			// 'auto' mode
			return { type: 'adaptive' };
		}

		return { type: 'enabled', budgetTokens: tokens };
	}

	/**
	 * Add resume and thinking tokens to options
	 * Called separately since these depend on session state at query time
	 */
	addSessionStateOptions(options: Options): Options {
		const result = { ...options } as Options & { thinking?: ThinkingConfig };

		// Add resume parameter if SDK session ID exists (session resumption)
		if (this.ctx.session.sdkSessionId) {
			result.resume = this.ctx.session.sdkSessionId;
		}

		// Add resumeSessionAt for conversation rewind
		// When set, only messages up to and including this UUID are resumed
		if (this.ctx.session.metadata?.resumeSessionAt) {
			result.resumeSessionAt = this.ctx.session.metadata.resumeSessionAt;
		}

		// Add thinking configuration based on thinkingLevel config
		const thinkingLevel = (this.ctx.session.config.thinkingLevel || 'auto') as ThinkingLevel;
		result.thinking = this.thinkingLevelToThinkingConfig(thinkingLevel);

		return result as Options;
	}

	/**
	 * Get the current working directory for the SDK
	 */
	getCwd(): string {
		return this.ctx.session.worktree
			? this.ctx.session.worktree.worktreePath
			: this.ctx.session.workspacePath;
	}

	/**
	 * Build system prompt configuration
	 *
	 * Priority:
	 * 1. SDKConfig systemPrompt (from session.config.systemPrompt)
	 * 2. Legacy tools config (useClaudeCodePreset)
	 * 3. Default: Claude Code preset
	 *
	 */
	private buildSystemPrompt(): Options['systemPrompt'] {
		const config = this.ctx.session.config;

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
			if (this.ctx.session.worktree) {
				presetConfig.append = this.getWorktreeIsolationText();
			}

			return presetConfig;
		}

		// No Claude Code preset - use minimal system prompt or undefined
		// When worktree is used, still append isolation instructions
		if (this.ctx.session.worktree) {
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
			if (this.ctx.session.worktree) {
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
			if (this.ctx.session.worktree) {
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
		const wt = this.ctx.session.worktree!;
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
		const wt = this.ctx.session.worktree!;
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
	 * 2. Legacy kaiTools config (memory tool control)
	 */
	private getDisallowedTools(): string[] {
		const config = this.ctx.session.config;
		const disallowedTools: string[] = [];

		// Add SDKConfig disallowedTools
		if (config.disallowedTools && config.disallowedTools.length > 0) {
			disallowedTools.push(...config.disallowedTools);
		}

		// Legacy: Disable NeoKai memory tool if not enabled
		const legacyToolsConfig = config.tools;
		if (!legacyToolsConfig?.kaiTools?.memory) {
			disallowedTools.push('kai__memory__*');
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
		const config = this.ctx.session.config;

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
	 */
	private getMcpServers(): Record<string, unknown> | undefined {
		// Use SDKConfig mcpServers if explicitly set
		const config = this.ctx.session.config;
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
		const toolsConfig = this.ctx.session.config.tools;
		const loadSettingSources = toolsConfig?.loadSettingSources ?? true;
		return loadSettingSources ? ['project', 'local'] : ['local'];
	}

	/**
	 * Get additional directories configuration
	 *
	 * Always includes:
	 * - ~/.claude/: For settings, database, and worktree storage
	 * - ~/.neokai/: For NeoKai-specific configuration and state
	 *
	 * For worktree sessions, also includes:
	 * - /tmp/claude: SDK sets TMPDIR=/tmp/claude, most shells (bash, fish, etc.) respect this
	 * - /tmp/zsh-${uid}: Zsh's default behavior creates /tmp/zsh-UID paths
	 *
	 * This ensures shell operations (git commits, heredocs, etc.) work within the sandbox
	 * without fighting any shell's natural temp file behavior.
	 */
	private getAdditionalDirectories(): string[] | undefined {
		const directories: string[] = [];

		// Always include Claude and NeoKai directories for settings and storage
		directories.push(join(homedir(), '.claude'));
		directories.push(join(homedir(), '.neokai'));

		// For worktree sessions, also allow temp directories for shell operations
		if (this.ctx.session.worktree) {
			const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
			directories.push('/tmp/claude', `/tmp/zsh-${uid}`);
		}

		return directories;
	}

	/**
	 * Get merged environment variables for SDK subprocess
	 *
	 * IMPORTANT: Provider env vars (GLM, etc.) are now applied to process.env
	 * before SDK query creation, NOT passed via options.env.
	 *
	 * This method merges:
	 * 1. Global settings env vars (from ~/.Claude/settings.json)
	 * 2. Session config env vars (from session.config.env)
	 *
	 * Provider-specific env vars (ANTHROPIC_*, API_TIMEOUT_MS, etc.) are filtered out
	 * because those are handled by applyEnvVarsToProcess() in AgentSession.
	 *
	 * Priority: Session env vars override global env vars.
	 *
	 * @returns Merged env vars (excluding provider-specific vars)
	 */
	private getMergedEnvironmentVars(): Record<string, string> | undefined {
		const globalSettings = this.ctx.settingsManager.getGlobalSettings();
		const sessionEnv = this.ctx.session.config.env;

		// Provider-specific env vars that are managed by the provider system
		// These should NOT be passed via options.env as they won't work for GLM
		const providerEnvVars = new Set([
			'ANTHROPIC_BASE_URL',
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_AUTH_TOKEN',
			'ANTHROPIC_MODEL',
			'ANTHROPIC_DEFAULT_HAIKU_MODEL',
			'ANTHROPIC_DEFAULT_SONNET_MODEL',
			'ANTHROPIC_DEFAULT_OPUS_MODEL',
			'API_TIMEOUT_MS',
			'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
		]);

		const mergedEnv: Record<string, string> = {};

		// 1. Add global settings env vars (filtered)
		if (globalSettings.env) {
			for (const [key, value] of Object.entries(globalSettings.env)) {
				if (value !== undefined && !providerEnvVars.has(key)) {
					mergedEnv[key] = value;
				}
			}
		}

		// 2. Add session config env vars (filtered, overrides global)
		if (sessionEnv) {
			for (const [key, value] of Object.entries(sessionEnv)) {
				if (value !== undefined && !providerEnvVars.has(key)) {
					mergedEnv[key] = value;
				}
			}
		}

		return Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined;
	}

	/**
	/**
	 * Get permission mode with 2-layer priority system
	 *
	 * Priority:
	 * 1. Session config (highest priority)
	 * 2. Global settings
	 * 3. Default: 'bypassPermissions'
	 *
	 * @returns Permission mode for SDK operations
	 */
	private getPermissionMode(): PermissionMode {
		// Layer 1: Session config (highest priority)
		if (this.ctx.session.config.permissionMode) {
			if (this.ctx.session.config.permissionMode === 'default') {
				return 'bypassPermissions';
			}
			return this.ctx.session.config.permissionMode;
		}

		// Layer 2: Global settings
		const globalSettings = this.ctx.settingsManager.getGlobalSettings();
		if (globalSettings.permissionMode) {
			if (globalSettings.permissionMode === 'default') {
				return 'bypassPermissions';
			}
			return globalSettings.permissionMode;
		}

		// Layer 3: Default
		return 'bypassPermissions';
	}

	/**
	 * Get SDK options from global settings
	 *
	 * This writes file-only settings to .claude/settings.local.json and returns
	 * SDK-supported options to merge with query options
	 */
	private async getSettingsOptions(): Promise<Partial<Options>> {
		const toolsConfig = this.ctx.session.config.tools;
		return await this.ctx.settingsManager.prepareSDKOptions({
			disabledMcpServers: toolsConfig?.disabledMcpServers ?? [],
		});
	}

	/**
	 * Build hooks configuration
	 */
	private buildHooks(): Options['hooks'] {
		return {};
	}

	/**
	 * Get SDK CLI path
	 *
	 * Priority:
	 * 1. Session config explicit path
	 * 2. Auto-resolved path from SDK installation
	 * 3. undefined (let SDK use its default)
	 */
	private getSDKCliPath(): string | undefined {
		const config = this.ctx.session.config;

		// Priority 1: Explicit path from config
		if (config.pathToClaudeCodeExecutable) {
			return config.pathToClaudeCodeExecutable;
		}

		// Priority 2: Auto-resolve from SDK installation
		// This is critical for bundled binaries where SDK's internal
		// resolution produces virtual /$bunfs/root paths
		const resolvedPath = resolveSDKCliPath();
		if (resolvedPath) {
			return resolvedPath;
		}

		// Priority 3: Let SDK use its default resolution
		return undefined;
	}
}
