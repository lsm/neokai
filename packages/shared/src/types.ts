import type { SettingSource } from "./types/settings.ts";
import type { ResolvedQuestion } from "./state-types.ts";
import type { SDKConfig, ToolsPresetConfig } from "./types/sdk-config.ts";

// Re-export SDK config types for convenience
export type {
  SDKConfig,
  SystemPromptConfig,
  ClaudeCodePreset,
  ToolsPresetConfig,
  ToolsPreset,
  ToolsSettings,
  AgentModel,
  AgentDefinition,
  AgentMcpServerSpec,
  AgentsConfig,
  SandboxSettings,
  NetworkSandboxSettings,
  SandboxIgnoreViolations,
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpSettings,
  OutputFormatConfig,
  PluginConfig,
  SdkBeta,
  ModelSettings,
  EnvironmentSettings,
  SessionResumptionSettings,
  ConfigUpdateResult,
  ValidationResult,
} from "./types/sdk-config.ts";
export { CONFIG_CHANGE_BEHAVIOR } from "./types/sdk-config.ts";

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
}

// Backward compatibility alias (use SessionInfo in new code)
export type Session = SessionInfo;

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

export type SessionStatus = "active" | "paused" | "ended" | "archived";

// ============================================================================
// Provider Types
// ============================================================================

/**
 * Supported AI providers
 * - 'anthropic': Default Claude API provider
 * - 'glm': GLM (智谱AI) via Anthropic-compatible API
 */
export type Provider = "anthropic" | "glm";

/**
 * Provider-specific configuration
 * Allows per-session API key overrides
 */
export interface ProviderConfig {
  /** Provider-specific API key (optional, uses global env var if not set) */
  apiKey?: string;
  /** Custom base URL override (optional, uses provider default if not set) */
  baseUrl?: string;
}

/**
 * Information about an available provider
 */
export interface ProviderInfo {
  /** Provider identifier */
  id: Provider;
  /** Display name */
  name: string;
  /** API base URL (undefined for default Anthropic) */
  baseUrl?: string;
  /** Available model IDs for this provider */
  models: string[];
  /** Whether this provider is configured (has API key) */
  available: boolean;
}

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
export type ThinkingLevel = "auto" | "think8k" | "think16k" | "think32k";

/**
 * Mapping from ThinkingLevel to maxThinkingTokens value
 */
export const THINKING_LEVEL_TOKENS: Record<ThinkingLevel, number | undefined> =
  {
    auto: undefined,
    think8k: 8000,
    think16k: 16000,
    think32k: 31999,
  };

/**
 * Session configuration extending SDKConfig with UI-specific settings
 *
 * This interface combines all SDK options from SDKConfig with
 * Liuboer-specific UI settings like autoScroll and queryMode.
 *
 * For backward compatibility:
 * - The existing `tools?: ToolsConfig` field is preserved for Liuboer-specific UI settings
 * - SDKConfig's `tools` field (for tool selection) is available as `sdkToolsPreset`
 * - Other SDKConfig properties like `allowedTools`, `disallowedTools` are inherited directly
 */
export interface SessionConfig extends Omit<SDKConfig, "tools"> {
  /**
   * AI provider to use for this session
   * @default 'anthropic'
   */
  provider?: Provider;

  /**
   * Provider-specific configuration (optional)
   * Allows per-session API key overrides
   */
  providerConfig?: ProviderConfig;

  /**
   * Model ID (required)
   * @example 'claude-sonnet-4-5-20250929'
   */
  model: string;

  /**
   * Maximum output tokens (legacy, not currently passed to SDK)
   * @deprecated Use SDK's default token limits
   */
  maxTokens: number;

  /**
   * Temperature for model responses (legacy, not currently passed to SDK)
   * @deprecated SDK manages temperature internally
   */
  temperature: number;

  /**
   * Auto-scroll to bottom when new messages arrive (UI-only)
   * @default true
   */
  autoScroll?: boolean;

  /**
   * Thinking level for extended thinking
   * Maps to maxThinkingTokens in SDK options
   * @default 'auto'
   */
  thinkingLevel?: ThinkingLevel;

  /**
   * Query mode for message sending behavior
   * - 'immediate': Messages sent to Claude immediately (default)
   * - 'manual': Messages saved but not sent until explicitly triggered
   *
   * Note: Auto-queue behavior (messages queued during processing) is automatic
   * and doesn't require a separate mode setting.
   * @default 'immediate'
   */
  queryMode?: "immediate" | "manual";

  /**
   * Legacy tools configuration for session (Liuboer-specific UI settings)
   * Controls system prompt preset, setting sources, MCP tools, and Liuboer tools
   *
   * This is different from SDK's tool selection. For SDK tool selection, use:
   * - sdkToolsPreset: Select which tools to enable (array or preset)
   * - allowedTools: Auto-allow specific tools without permission prompts
   * - disallowedTools: Disable specific tools entirely
   */
  tools?: ToolsConfig;

  /**
   * SDK tool selection configuration
   * Specifies which tools are available for the agent
   *
   * @example
   * // Use Claude Code preset (all default tools)
   * sdkToolsPreset: { type: 'preset', preset: 'claude_code' }
   *
   * @example
   * // Use specific tools only
   * sdkToolsPreset: ['Read', 'Write', 'Bash']
   */
  sdkToolsPreset?: ToolsPresetConfig;

  /**
   * Custom function to spawn the Claude Code process.
   * Used for testing to track SDK subprocess PID.
   * This is a runtime-only callback, not persisted to database.
   * @internal
   * @remarks Uses 'any' type to match SDK's SpawnOptions and SpawnedProcess
   * interfaces which are not directly exported from the SDK package.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnClaudeCodeProcess?: (options: any) => any;

  // Note: The following are inherited from SDKConfig and available:
  // - systemPrompt: Custom system prompt or Claude Code preset
  // - allowedTools: Auto-allow specific tools without permission prompts
  // - disallowedTools: Disable specific tools entirely
  // - agents: Custom subagent definitions
  // - sandbox: Sandbox configuration
  // - mcpServers: MCP server configuration
  // - outputFormat: Structured output JSON schema
  // - plugins: Plugin configurations
  // - betas: Beta feature flags
  // - settingSources: Setting file sources
  // - env: Environment variables
  // - maxTurns: Maximum conversation turns
  // - maxBudgetUsd: Cost limit
  // - fallbackModel: Fallback model ID
  // - permissionMode: Permission mode for SDK operations
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
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string; // base64 encoded
  };
}

/**
 * Tool result content for responding to tool use requests (e.g., AskUserQuestion)
 * Used when sending tool results through the streaming input queue
 */
export interface ToolResultContent {
  type: "tool_result";
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
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
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
  | "sdk.message"
  | "context.updated"
  | "context.compacting" // Compaction started (lock UI)
  | "context.compacted" // Compaction finished (unlock UI)
  | "tools.loaded"
  | "tools.unloaded"
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "session.ended"
  | "session.interrupted"
  | "message.queued"
  | "message.processing"
  | "error"
  // Client → Server request events
  | "session.create.request"
  | "session.list.request"
  | "session.get.request"
  | "session.update.request"
  | "session.delete.request"
  | "message.send" // Already exists
  | "message.list.request"
  | "message.sdkMessages.request"
  | "file.read.request"
  | "file.list.request"
  | "file.tree.request"
  | "system.health.request"
  | "system.config.request"
  | "auth.status.request"
  // Server → Client response events
  | "session.create.response"
  | "session.list.response"
  | "session.get.response"
  | "session.update.response"
  | "session.delete.response"
  | "message.list.response"
  | "message.sdkMessages.response"
  | "file.read.response"
  | "file.list.response"
  | "file.tree.response"
  | "system.health.response"
  | "system.config.response"
  | "auth.status.response"
  // Client presence/interaction events
  | "message.cancel"
  | "client.typing"
  | "client.presence"
  | "client.cursor"
  | "client.action"
  | "client.interrupt"
  | "client.ack"
  // WebSocket heartbeat events (internal)
  | "ping"
  | "pong";

// File system types
export interface FileInfo {
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: string;
}

export interface FileTree {
  name: string;
  path: string;
  type: "file" | "directory";
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
  status: "running" | "completed" | "error";
  result?: unknown;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// Health check
export interface HealthStatus {
  status: "ok" | "error";
  version: string;
  uptime: number;
  sessions: {
    active: number;
    total: number;
  };
}

// Authentication types
export type AuthMethod = "oauth" | "oauth_token" | "api_key" | "none";

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
  source?: "env" | "database"; // Where the credentials come from
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
  category?: "chat" | "session" | "system" | "debug";
  requiresConfirmation?: boolean;
  parameters?: CommandParameter[];
}

export interface CommandParameter {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
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
  displayType?: "text" | "markdown" | "json" | "component";
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
  source?: "stream" | "context-command" | "merged"; // Source of context data
}
