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
}

export interface WorktreeMetadata {
	isWorktree: true;
	worktreePath: string;
	mainRepoPath: string;
	branch: string;
}

export type SessionStatus = 'active' | 'paused' | 'ended';

export interface SessionConfig {
	model: string;
	maxTokens: number;
	temperature: number;
	autoScroll?: boolean;
}

export interface SessionMetadata {
	messageCount: number;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	totalCost: number;
	toolCallCount: number;
	titleGenerated?: boolean; // Flag to track if title has been auto-generated
	lastContextInfo?: ContextInfo | null; // Last known context info (persisted)
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
