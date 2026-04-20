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

import type { Options, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
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
import type { McpServerConfig } from '@neokai/shared/types/sdk-config';
import type { AppMcpServerSourceType } from '@neokai/shared';
import type { SettingsManager } from '../settings-manager';
import type { SkillsManager } from '../skills-manager';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository';
import type { RoomSkillOverride } from '@neokai/shared';
import { getProviderContextManager } from '../providers/factory.js';
import { resolveSDKCliPath, isRunningUnderBun } from './sdk-cli-resolver.js';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Context interface - what QueryOptionsBuilder needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface QueryOptionsBuilderContext {
	readonly session: Session;
	readonly settingsManager: SettingsManager;
	/** Skills manager for injecting plugin/MCP server skills into SDK options. Optional for backwards compatibility. */
	readonly skillsManager?: SkillsManager;
	/** App MCP server repo for resolving mcp_server skill configs. Optional for backwards compatibility. */
	readonly appMcpServerRepo?: AppMcpServerRepository;
	/**
	 * Room-level skill overrides. When provided, a skill with `enabled: false` in this list
	 * is excluded from injection even if it is globally enabled in the skills registry.
	 */
	readonly roomSkillOverrides?: RoomSkillOverride[];
}

export class QueryOptionsBuilder {
	private canUseTool?: CanUseTool;

	constructor(private ctx: QueryOptionsBuilderContext) {}

	/**
	 * Set the canUseTool callback for handling tool permissions
	 * This is used for AskUserQuestion and other interactive tools
	 */
	setCanUseTool(callback: CanUseTool): void {
		this.canUseTool = callback;
	}

	/**
	 * Return MCP servers contributed by enabled skills for this session.
	 * Skips skills that are room-disabled and AppMcpServer entries that are disabled.
	 * Useful for inspecting effective skill injection without running a full build.
	 */
	getSkillMcpServers(): Record<string, McpServerConfig> {
		return this.getMcpServersFromSkills();
	}

	/**
	 * Build complete SDK query options
	 *
	 * Maps all SessionConfig (which extends SDKConfig) options to SDK Options
	 */
	async build(): Promise<Options> {
		const config = this.ctx.session.config;

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
		const pluginsFromSkills = [
			...this.buildPluginsFromSkills(),
			...this.buildPluginsFromBuiltinSkills(),
		];
		const mcpServersFromSkills = this.getMcpServersFromSkills();
		const mergedEnv = this.getMergedEnvironmentVars();
		const sdkCliPath = this.getSDKCliPath();

		// Disabled MCP server names from tools config.
		// These are filtered from the mcpServers map directly so the exclusion
		// applies to ALL session types — including room_chat which sets settingSources: []
		// and therefore never reads disabledMcpjsonServers from settings.local.json.
		const toolsConfig = config.tools;
		const disabledMcpServers = toolsConfig?.disabledMcpServers ?? [];
		const mergedMcpServers = this.filterDisabledMcpServers(
			this.mergeMcpServers(mcpServers, mcpServersFromSkills),
			disabledMcpServers
		);

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
			// Skill-injected MCP servers: must appear in mcpServers map for
			// strictMcpConfig sessions to accept them. When strictMcpConfig is true
			// (e.g. room_chat sessions), the SDK only allows servers present in this
			// map — user settings are ignored. By merging skill servers here, they
			// are always available regardless of strictMcpConfig setting.
			// Disabled servers are already filtered out by filterDisabledMcpServers above.
			mcpServers: mergedMcpServers as Options['mcpServers'],
			strictMcpConfig: config.strictMcpConfig,

			// ============ Output Format ============
			outputFormat: config.outputFormat,

			// ============ Plugins ============
			plugins: this.mergePlugins(config.plugins, pluginsFromSkills),

			// ============ Beta Features ============
			betas: config.betas,

			// ============ Environment ============
			cwd: this.getCwd(),
			additionalDirectories,
			env: mergedEnv,
			// When running under Bun (dev, test, or compiled binary), set the subprocess
			// runtime to 'bun' so it shares the same Node.js compat layer (e.g. node:sqlite
			// requires v22.5+ but is available in Bun). Without this, CI runners with an
			// older Node.js on PATH would fail when spawning the SDK's cli.js subprocess.
			executable: config.executable ?? (isRunningUnderBun() ? 'bun' : undefined),
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
		// Room chat sessions are orchestrators — they have read tools, Bash for diagnostics,
		// and explicitly configured MCP servers (room-agent-tools + project MCP servers).
		// File editing tools (Write/Edit/NotebookEdit) are excluded.
		if (this.ctx.session.type === 'room_chat') {
			const roomAllowedBuiltinTools = [
				'Read',
				'Glob',
				'Grep',
				'Bash',
				'WebFetch',
				'WebSearch',
				'ToolSearch',
				'AskUserQuestion',
				'Skill',
			];
			const restrictedBuiltinTools = [
				'Task',
				'TaskOutput',
				'TaskStop',
				'Edit',
				'Write',
				'NotebookEdit',
			];
			// Room chat must not use Claude Code preset prompt by default.
			const systemPrompt = queryOptions.systemPrompt;
			if (
				typeof systemPrompt === 'object' &&
				systemPrompt !== null &&
				(systemPrompt as ClaudeCodePreset).type === 'preset' &&
				(systemPrompt as ClaudeCodePreset).preset === 'claude_code'
			) {
				queryOptions.systemPrompt = undefined;
			}

			// Restrict room chat to coordinator-appropriate built-in tool set.
			queryOptions.tools = roomAllowedBuiltinTools;

			// Auto-allow all explicitly configured MCP server tools (room-agent-tools + project MCP servers).
			const mcpServerWildcards = Object.keys(queryOptions.mcpServers ?? {}).map(
				(name) => `${name}__*`
			);
			queryOptions.allowedTools = [
				...new Set([
					...(queryOptions.allowedTools ?? []),
					...roomAllowedBuiltinTools,
					...mcpServerWildcards,
				]),
			];

			queryOptions.disallowedTools = [
				...new Set([...(queryOptions.disallowedTools ?? []), ...restrictedBuiltinTools]),
			];
			// Prevent user-configured MCP servers from being merged in (only runtime-injected servers allowed).
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
	getCwd(): string | undefined {
		if (this.ctx.session.worktree) {
			return this.ctx.session.worktree.worktreePath;
		}
		return this.ctx.session.workspacePath ?? undefined;
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
	 * Returns SDKConfig disallowedTools (explicit tools to disable)
	 */
	private getDisallowedTools(): string[] {
		const config = this.ctx.session.config;
		const disallowedTools: string[] = [];

		// Add SDKConfig disallowedTools
		if (config.disallowedTools && config.disallowedTools.length > 0) {
			disallowedTools.push(...config.disallowedTools);
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
	 */
	private getMcpServers(): Record<string, unknown> | undefined {
		// Use SDKConfig mcpServers if explicitly set
		const config = this.ctx.session.config;
		if (config.mcpServers !== undefined) {
			return config.mcpServers as Record<string, unknown>;
		}

		// Let SDK auto-load from settings files
		return undefined;
	}

	/**
	 * Merge config MCP servers with skill-injected MCP servers.
	 * Returns undefined when neither source has servers (preserves auto-load behavior).
	 */
	private mergeMcpServers(
		configServers: Record<string, unknown> | undefined,
		skillServers: Record<string, McpServerConfig>
	): Record<string, unknown> | undefined {
		const hasSkillServers = Object.keys(skillServers).length > 0;
		if (!configServers && !hasSkillServers) return undefined;
		return { ...skillServers, ...configServers };
	}

	/**
	 * Merge config plugins with skill-injected plugins.
	 * Returns undefined when neither source has plugins.
	 */
	private mergePlugins(
		configPlugins: Options['plugins'],
		skillPlugins: Array<{ type: 'local'; path: string }>
	): Options['plugins'] {
		if (!configPlugins && skillPlugins.length === 0) return undefined;
		return [...(configPlugins ?? []), ...skillPlugins];
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
	 * - /tmp: System temp for tools that write directly here (e.g. git hook tee, bun test)
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
			directories.push('/tmp', '/tmp/claude', `/tmp/zsh-${uid}`);
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

		// 3. Explicitly include proxy environment variables for Dev Proxy support
		// These are set by the dev-proxy test helper and need to be passed to the SDK subprocess
		// See: https://github.com/dotnet/dev-proxy/issues/169
		const proxyEnvVars = [
			'HTTPS_PROXY',
			'HTTP_PROXY',
			'NODE_USE_ENV_PROXY',
			'NODE_EXTRA_CA_CERTS',
		] as const;
		for (const key of proxyEnvVars) {
			const value = process.env[key];
			if (value !== undefined) {
				mergedEnv[key] = value;
			}
		}

		// Always return mergedEnv (not undefined) when proxy vars are present
		// This ensures SDK subprocess receives proxy environment variables
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
	 * Filter disabled MCP servers from the merged servers map.
	 *
	 * This ensures disabledMcpServers takes effect for ALL session types,
	 * including room_chat sessions that set settingSources: [] and therefore
	 * never read disabledMcpjsonServers from .claude/settings.local.json.
	 */
	private filterDisabledMcpServers(
		servers: Record<string, unknown> | undefined,
		disabledList: string[]
	): Record<string, unknown> | undefined {
		if (!servers || disabledList.length === 0) return servers;
		const filtered = { ...servers };
		for (const name of disabledList) {
			delete filtered[name];
		}
		return Object.keys(filtered).length > 0 ? filtered : undefined;
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

	/**
	 * Returns the set of skill IDs disabled by room-level overrides.
	 * A skill in this set must be excluded even if globally enabled.
	 */
	private getRoomDisabledSkillIds(): Set<string> {
		if (!this.ctx.roomSkillOverrides?.length) return new Set();
		return new Set(this.ctx.roomSkillOverrides.filter((o) => !o.enabled).map((o) => o.skillId));
	}

	/**
	 * Build plugin entries from enabled skills with sourceType === 'plugin'.
	 * Room overrides with enabled=false exclude the skill even if globally enabled.
	 * Returns an array of SdkPluginConfig objects for injection into options.plugins.
	 */
	private buildPluginsFromSkills(): Array<{ type: 'local'; path: string }> {
		if (!this.ctx.skillsManager) return [];

		const skills = this.ctx.skillsManager.getEnabledSkills();
		const roomDisabled = this.getRoomDisabledSkillIds();
		const plugins: Array<{ type: 'local'; path: string }> = [];

		for (const skill of skills) {
			if (roomDisabled.has(skill.id)) continue;
			if (skill.sourceType === 'plugin' && skill.config.type === 'plugin') {
				plugins.push({ type: 'local', path: skill.config.pluginPath });
			}
		}

		return plugins;
	}

	/**
	 * Build plugin entries from enabled skills with sourceType === 'builtin'.
	 * Each builtin skill's commandName resolves to ~/.neokai/skills/{commandName}/
	 * which is populated at startup (by the prod binary extraction step or the dev
	 * server sync step). These directories are registered as local SDK plugins so
	 * the SDK discovers their SKILL.md content as slash commands.
	 *
	 * Room overrides with enabled=false exclude the skill even if globally enabled.
	 */
	private buildPluginsFromBuiltinSkills(): Array<{ type: 'local'; path: string }> {
		if (!this.ctx.skillsManager) return [];

		const skills = this.ctx.skillsManager.getEnabledSkills();
		const roomDisabled = this.getRoomDisabledSkillIds();
		const plugins: Array<{ type: 'local'; path: string }> = [];

		for (const skill of skills) {
			if (roomDisabled.has(skill.id)) continue;
			if (skill.sourceType === 'builtin' && skill.config.type === 'builtin') {
				const skillDir = join(homedir(), '.neokai', 'skills', skill.config.commandName);
				plugins.push({ type: 'local', path: skillDir });
			}
		}

		return plugins;
	}

	/**
	 * Build MCP server entries from enabled skills with sourceType === 'mcp_server'.
	 * Room overrides with enabled=false exclude the skill even if globally enabled.
	 * Resolves each skill's appMcpServerId to an AppMcpServer entry and maps it
	 * to an McpServerConfig keyed by skill.name.
	 *
	 * Skill-injected MCP servers: must appear in mcpServers map for
	 * strictMcpConfig sessions to accept them.
	 */
	private getMcpServersFromSkills(): Record<string, McpServerConfig> {
		if (!this.ctx.skillsManager || !this.ctx.appMcpServerRepo) return {};

		const skills = this.ctx.skillsManager.getEnabledSkills();
		const roomDisabled = this.getRoomDisabledSkillIds();
		const servers: Record<string, McpServerConfig> = {};

		for (const skill of skills) {
			if (roomDisabled.has(skill.id)) continue;
			if (skill.sourceType !== 'mcp_server' || skill.config.type !== 'mcp_server') continue;

			const appServer = this.ctx.appMcpServerRepo.get(skill.config.appMcpServerId);
			// Skip silently if the referenced app_mcp_servers entry was deleted or no longer exists
			if (!appServer) continue;
			// Skip if the AppMcpServer itself is disabled, even if the wrapping skill is enabled
			if (!appServer.enabled) continue;

			servers[skill.name] = this.appMcpServerToSdkConfig(appServer);
		}

		return servers;
	}

	/**
	 * Convert an AppMcpServer to the SDK's McpServerConfig format.
	 */
	private appMcpServerToSdkConfig(server: {
		sourceType: AppMcpServerSourceType;
		command?: string;
		args?: string[];
		env?: Record<string, string>;
		url?: string;
		headers?: Record<string, string>;
	}): McpServerConfig {
		switch (server.sourceType) {
			case 'stdio':
				return {
					command: server.command!,
					...(server.args ? { args: server.args } : {}),
					...(server.env ? { env: server.env } : {}),
				};
			case 'sse':
				return {
					type: 'sse',
					url: server.url!,
					...(server.headers ? { headers: server.headers } : {}),
				};
			case 'http':
				return {
					type: 'http',
					url: server.url!,
					...(server.headers ? { headers: server.headers } : {}),
				};
			default: {
				const _exhaustive: never = server.sourceType;
				throw new Error(`Unknown MCP server source type: ${_exhaustive}`);
			}
		}
	}
}
