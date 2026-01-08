import type { SettingSource } from './types/settings.ts';
import type { ResolvedQuestion } from './state-types.ts';

// Core session types
export interface SessionInfo {
	id: string;
	title: string;
	workspacePath: string;
	createdAt: string;
	lastActiveAt: string;
	status: SessionStatus;
	config: SessionConfig;
	metadata: SessionMetadata;
	worktree?: WorktreeMetadata;
	gitBranch?: string; // Current git branch for non-worktree sessions in git repos
	sdkSessionId?: string; // SDK's internal session ID for resuming conversations
	availableCommands?: string[]; // Available slash commands for this session (persisted)
	processingState?: string; // Persisted agent processing state (JSON serialized AgentProcessingState)
	archivedAt?: string; // ISO timestamp when session was archived
	// Sub-session fields
	parentId?: string; // ID of parent session (null/undefined for root sessions)
	labels?: string[]; // Labels for categorization
	subSessionOrder?: number; // Order among siblings (for UI ordering)
}

// Backward compatibility alias (use SessionInfo in new code)
export type Session = SessionInfo;

/**
 * Configuration for creating sub-sessions
 * Controls inheritance and categorization options
 */
export interface SubSessionConfig {
	// Inherit options from parent
	inheritModel?: boolean; // Default: true
	inheritPermissionMode?: boolean; // Default: true
	inheritWorktree?: boolean; // Default: false (sub-sessions get own worktree by default)

	// Labels for categorization
	labels?: string[];
}

export interface WorktreeMetadata {
	isWorktree: true;
	worktreePath: string;
	mainRepoPath: string;
	branch: string;
}

export interface CommitInfo {
	hash: string;
	message: string;
	author: string;
	date: string;
}

export interface WorktreeCommitStatus {
	hasCommitsAhead: boolean;
	commits: CommitInfo[];
	baseBranch: string;
}

export type SessionStatus = 'active' | 'paused' | 'ended' | 'archived';

/**
 * Thinking level options for extended thinking
 *
 * Sets maxThinkingTokens budget for the SDK:
 * - 'auto': No thinking budget - SDK default behavior
 * - 'think8k': 8000 tokens thinking budget
 * - 'think16k': 16000 tokens thinking budget
 * - 'think32k': 31999 tokens thinking budget
 *
 * Note: The "ultrathink" keyword is NOT auto-appended. Users must type it explicitly if needed.
 */
export type ThinkingLevel = 'auto' | 'think8k' | 'think16k' | 'think32k';

/**
 * Mapping from ThinkingLevel to maxThinkingTokens value
 */
export const THINKING_LEVEL_TOKENS: Record<ThinkingLevel, number | undefined> = {
	auto: undefined,
	think8k: 8000,
	think16k: 16000,
	think32k: 31999,
};

export interface SessionConfig {
	model: string;
	maxTokens: number;
	temperature: number;
	autoScroll?: boolean;
	/**
	 * Thinking level for extended thinking
	 * @default 'auto'
	 */
	thinkingLevel?: ThinkingLevel;
	/**
	 * @deprecated Use thinkingLevel instead
	 */
	maxThinkingTokens?: number | null;
	/**
	 * Permission mode for SDK operations
	 * - 'bypassPermissions': Most permissive, skips all permission checks (default)
	 * - 'acceptEdits': Auto-accepts tool edits, works in CI environments
	 * - 'default': SDK default behavior
	 * - 'plan': Planning mode
	 * - 'delegate': Delegate permissions
	 * - 'dontAsk': Don't prompt, deny if not pre-approved
	 * @default 'bypassPermissions'
	 */
	permissionMode?:
		| 'default'
		| 'acceptEdits'
		| 'bypassPermissions'
		| 'plan'
		| 'delegate'
		| 'dontAsk';
	/**
	 * Query mode for message sending behavior
	 * - 'immediate': Messages sent to Claude immediately (default)
	 * - 'manual': Messages saved but not sent until explicitly triggered
	 *
	 * Note: Auto-queue behavior (messages queued during processing) is automatic
	 * and doesn't require a separate mode setting.
	 * @default 'immediate'
	 */
	queryMode?: 'immediate' | 'manual';
	// Tools configuration
	tools?: ToolsConfig;
}

/**
 * Tools configuration for a session
 * Controls system prompt, setting sources, MCP tools, and Liuboer tools
 *
 * SDK Terms Reference:
 * - systemPrompt: { type: 'preset', preset: 'claude_code' } - The Claude Code system prompt
 * - settingSources: ['project', 'local', 'user'] - Which config files to load
 */
export interface ToolsConfig {
	// System Prompt: Use Claude Code preset (default: true)
	// SDK option: systemPrompt: { type: 'preset', preset: 'claude_code' }
	// When false, uses empty/minimal system prompt
	useClaudeCodePreset?: boolean;
	// Setting Sources: Which sources to load settings from
	// SDK option: settingSources: ['user', 'project', 'local']
	// Controls loading of CLAUDE.md, .claude/settings.json, .claude/settings.local.json
	settingSources?: SettingSource[];
	// Legacy field - deprecated, use settingSources instead
	loadSettingSources?: boolean;

	// ============================================================================
	// MCP Server Control (Direct 1:1 UI→SDK Mapping)
	// ============================================================================
	// disabledMcpServers is written to .claude/settings.local.json as disabledMcpjsonServers
	// SDK reads this file and applies filtering automatically
	// Empty array = all servers enabled; server name in array = that server disabled

	// List of MCP server names to disable (unchecked in UI)
	// Written to settings.local.json as "disabledMcpjsonServers"
	disabledMcpServers?: string[];

	// Liuboer-specific tools (not SDK built-in tools)
	liuboerTools?: {
		// Memory tool: persistent key-value storage for the workspace
		memory?: boolean;
	};
}

/**
 * Global tools configuration
 * Two-stage control: 1) allowed or not, 2) default for new sessions
 * Stored at the daemon level, applies to all sessions
 *
 * SDK Terms Reference:
 * - systemPrompt: { type: 'preset', preset: 'claude_code' } - The Claude Code system prompt
 * - settingSources: ['project', 'local', 'user'] - Which config files to load
 */
export interface GlobalToolsConfig {
	// System Prompt settings
	systemPrompt: {
		// Claude Code preset: Use the official Claude Code system prompt
		// SDK option: systemPrompt: { type: 'preset', preset: 'claude_code' }
		claudeCodePreset: {
			allowed: boolean;
			defaultEnabled: boolean;
		};
	};
	// Setting Sources settings
	settingSources: {
		// Project settings: Load from settingSources: ['project', 'local']
		// Controls CLAUDE.md, .claude/settings.json, .claude/settings.local.json loading
		project: {
			allowed: boolean;
			defaultEnabled: boolean;
		};
	};
	// MCP tools settings
	mcp: {
		// Is loading project MCP allowed?
		allowProjectMcp: boolean;
		// Default for new sessions
		defaultProjectMcp: boolean;
	};
	// Liuboer-specific tools settings
	liuboerTools: {
		memory: {
			allowed: boolean;
			defaultEnabled: boolean;
		};
	};
}

/**
 * Default global tools configuration
 * All features enabled by default, MCP disabled by default
 */
export const DEFAULT_GLOBAL_TOOLS_CONFIG: GlobalToolsConfig = {
	systemPrompt: {
		claudeCodePreset: {
			allowed: true,
			defaultEnabled: true, // Use Claude Code preset by default
		},
	},
	settingSources: {
		project: {
			allowed: true,
			defaultEnabled: true, // Load project settings by default
		},
	},
	mcp: {
		allowProjectMcp: true, // Allow but don't enable by default
		defaultProjectMcp: false,
	},
	liuboerTools: {
		memory: {
			allowed: true,
			defaultEnabled: false,
		},
	},
};

export interface SessionMetadata {
	messageCount: number;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	totalCost: number;
	toolCallCount: number;
	titleGenerated?: boolean; // Flag to track if title has been auto-generated
	workspaceInitialized?: boolean; // Flag to track if workspace (title + worktree) has been initialized
	lastContextInfo?: ContextInfo | null; // Last known context info (persisted)
	inputDraft?: string; // Draft input text (persisted across sessions and devices)
	removedOutputs?: string[]; // UUIDs of messages whose tool_result outputs were removed from SDK session file
	resolvedQuestions?: Record<string, ResolvedQuestion>; // Resolved AskUserQuestion responses, keyed by toolUseId
	// Cost tracking: SDK reports cumulative cost per run, but resets on agent restart
	// We track lastSdkCost to detect resets and costBaseline to preserve pre-reset totals
	lastSdkCost?: number; // Last SDK-reported total_cost_usd (resets when agent restarts)
	costBaseline?: number; // Accumulated cost from previous runs before last reset
}

// Message content types for streaming input (supports images and tool results)
export type MessageContent = TextContent | ImageContent | ToolResultContent;

export interface TextContent {
	type: 'text';
	text: string;
}

export interface ImageContent {
	type: 'image';
	source: {
		type: 'base64';
		media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
		data: string; // base64 encoded
	};
}

/**
 * Tool result content for responding to tool use requests (e.g., AskUserQuestion)
 * Used when sending tool results through the streaming input queue
 */
export interface ToolResultContent {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
}

/**
 * Message image attachment
 * Represents an image that can be sent with a message
 */
export interface MessageImage {
	/**
	 * Base64 encoded image data
	 */
	data: string;

	/**
	 * MIME type of the image
	 */
	media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

// Tool types
export interface Tool {
	name: string;
	description: string;
	category: string;
	parameters: unknown; // JSON Schema
}

export interface ToolBundle {
	name: string;
	tools: string[];
	description: string;
}

// Event types
export interface Event {
	id: string;
	sessionId: string;
	type: EventType;
	data: unknown;
	timestamp: string;
}

export type EventType =
	// Server → Client events (broadcasts)
	| 'sdk.message'
	| 'context.updated'
	| 'context.compacting' // Compaction started (lock UI)
	| 'context.compacted' // Compaction finished (unlock UI)
	| 'tools.loaded'
	| 'tools.unloaded'
	| 'session.created'
	| 'session.updated'
	| 'session.deleted'
	| 'session.ended'
	| 'session.interrupted'
	| 'message.queued'
	| 'message.processing'
	| 'error'
	// Client → Server request events
	| 'session.create.request'
	| 'session.list.request'
	| 'session.get.request'
	| 'session.update.request'
	| 'session.delete.request'
	| 'message.send' // Already exists
	| 'message.list.request'
	| 'message.sdkMessages.request'
	| 'file.read.request'
	| 'file.list.request'
	| 'file.tree.request'
	| 'system.health.request'
	| 'system.config.request'
	| 'auth.status.request'
	// Server → Client response events
	| 'session.create.response'
	| 'session.list.response'
	| 'session.get.response'
	| 'session.update.response'
	| 'session.delete.response'
	| 'message.list.response'
	| 'message.sdkMessages.response'
	| 'file.read.response'
	| 'file.list.response'
	| 'file.tree.response'
	| 'system.health.response'
	| 'system.config.response'
	| 'auth.status.response'
	// Client presence/interaction events
	| 'message.cancel'
	| 'client.typing'
	| 'client.presence'
	| 'client.cursor'
	| 'client.action'
	| 'client.interrupt'
	| 'client.ack'
	// WebSocket heartbeat events (internal)
	| 'ping'
	| 'pong';

// File system types
export interface FileInfo {
	path: string;
	type: 'file' | 'directory';
	size: number;
	mtime: string;
}

export interface FileTree {
	name: string;
	path: string;
	type: 'file' | 'directory';
	children?: FileTree[];
}

export interface FileSnapshot {
	sessionId: string;
	timestamp: string;
	files: {
		path: string;
		content: string;
		hash: string;
	}[];
}

// Sub-agent types
export interface SubAgent {
	id: string;
	sessionId: string;
	parentId?: string;
	task: string;
	tools: string[];
	status: 'running' | 'completed' | 'error';
	result?: unknown;
	error?: string;
	createdAt: string;
	completedAt?: string;
}

// Health check
export interface HealthStatus {
	status: 'ok' | 'error';
	version: string;
	uptime: number;
	sessions: {
		active: number;
		total: number;
	};
}

// Authentication types
export type AuthMethod = 'oauth' | 'oauth_token' | 'api_key' | 'none';

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // Unix timestamp in milliseconds
	scopes: string[];
	isMax?: boolean;
}

export interface AuthStatus {
	method: AuthMethod;
	isAuthenticated: boolean;
	user?: {
		email?: string;
		name?: string;
	};
	expiresAt?: number;
	source?: 'env' | 'database'; // Where the credentials come from
}

// Configuration
export interface DaemonConfig {
	version: string;
	claudeSDKVersion: string;
	defaultModel: string;
	maxSessions: number;
	storageLocation: string;
	authMethod: AuthMethod;
	authStatus: AuthStatus;
}

// Slash Command types
export interface SlashCommand {
	name: string;
	description: string;
	usage?: string;
	aliases?: string[];
	category?: 'chat' | 'session' | 'system' | 'debug';
	requiresConfirmation?: boolean;
	parameters?: CommandParameter[];
}

export interface CommandParameter {
	name: string;
	description: string;
	type: 'string' | 'number' | 'boolean';
	required?: boolean;
	default?: unknown;
}

export interface CommandExecutionRequest {
	command: string;
	args?: string[];
	rawInput: string;
}

export interface CommandExecutionResult {
	success: boolean;
	message?: string;
	data?: unknown;
	error?: string;
	displayType?: 'text' | 'markdown' | 'json' | 'component';
}

// Context information types

/**
 * Category breakdown for context usage
 */
export interface ContextCategoryBreakdown {
	tokens: number;
	percent: number | null;
}

/**
 * SlashCommand tool statistics
 */
export interface ContextSlashCommandTool {
	commands: number;
	totalTokens: number;
}

/**
 * API usage statistics from Claude response
 */
export interface ContextAPIUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	webSearchRequests?: number; // SDK 0.1.69+
}

/**
 * Comprehensive context information from /context command
 * Includes model info, token usage, category breakdown, and tool statistics
 */
export interface ContextInfo {
	model: string | null;
	// Token usage
	totalUsed: number;
	totalCapacity: number;
	percentUsed: number;
	// Category breakdown
	breakdown: Record<string, ContextCategoryBreakdown>;
	// Optional additional info
	slashCommandTool?: ContextSlashCommandTool;
	apiUsage?: ContextAPIUsage;
	// Metadata
	lastUpdated?: number; // Timestamp of last update
	source?: 'stream' | 'context-command' | 'merged'; // Source of context data
}
