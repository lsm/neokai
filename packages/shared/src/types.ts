// Core session types
export interface Session {
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

export interface SessionConfig {
	model: string;
	maxTokens: number;
	temperature: number;
	autoScroll?: boolean;
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
	// Setting Sources: Load project settings from settingSources (default: true)
	// SDK option: settingSources: ['project', 'local']
	// Controls loading of CLAUDE.md, .claude/settings.json, .claude/settings.local.json
	loadSettingSources?: boolean;
	// Project MCP: Load .mcp.json from workspace (default: false)
	// When false: SDK option disallowedTools: ['mcp__*'] removes MCP tools from context
	// This saves tokens by not including MCP tool definitions in the model's context
	loadProjectMcp?: boolean;
	// Enabled MCP tool patterns (e.g., ["mcp__chrome-devtools__*"])
	enabledMcpPatterns?: string[];
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
}

// Message content types for streaming input (supports images)
export type MessageContent = TextContent | ImageContent;

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
