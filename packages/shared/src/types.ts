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
}

export type SessionStatus = "active" | "paused" | "ended";

export interface SessionConfig {
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface SessionMetadata {
  messageCount: number;
  totalTokens: number;
  toolCallCount: number;
}

// Message types
export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
  artifacts?: Artifact[];
  thinking?: string;
  metadata?: MessageMetadata;
}

export type MessageRole = "user" | "assistant" | "system";

export interface MessageMetadata {
  tokens?: number;
  duration?: number;
}

// Tool types
export interface ToolCall {
  id: string;
  messageId: string;
  tool: string;
  input: unknown;
  output?: unknown;
  status: ToolCallStatus;
  error?: string;
  duration?: number;
  timestamp: string;
}

export type ToolCallStatus = "pending" | "success" | "error";

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

// Artifact types
export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

export type ArtifactType = "code" | "image" | "file" | "diff";

// Event types
export interface Event {
  id: string;
  sessionId: string;
  type: EventType;
  data: unknown;
  timestamp: string;
}

export type EventType =
  | "message.start"
  | "message.content"
  | "message.complete"
  | "tool.call"
  | "tool.result"
  | "agent.thinking"
  | "agent.subagent_spawned"
  | "agent.subagent_completed"
  | "context.updated"
  | "context.compacted"
  | "tools.loaded"
  | "tools.unloaded"
  | "error"
  | "session.created"
  | "session.ended";

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

// Configuration
export interface DaemonConfig {
  version: string;
  claudeSDKVersion: string;
  defaultModel: string;
  maxSessions: number;
  storageLocation: string;
}
