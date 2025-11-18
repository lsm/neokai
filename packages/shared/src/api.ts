import type {
  AuthStatus,
  DaemonConfig,
  FileInfo,
  FileTree,
  HealthStatus,
  Message,
  OAuthTokens,
  Session,
  SessionConfig,
  Tool,
  ToolBundle,
} from "./types.ts";

// Request types
export interface CreateSessionRequest {
  workspacePath?: string;
  initialTools?: string[];
  config?: Partial<SessionConfig>;
}

export interface CreateSessionResponse {
  sessionId: string;
}

export interface ListSessionsResponse {
  sessions: Session[];
}

export interface GetSessionResponse {
  session: Session;
  messages: Message[];
  activeTools: string[];
  context: {
    files: string[];
    workingDirectory: string;
  };
}

export interface UpdateSessionRequest {
  title?: string;
  workspacePath?: string;
}

export interface SendMessageRequest {
  content: string;
  role?: "user";
  attachments?: {
    files?: string[];
    images?: string[];
  };
}

export interface SendMessageResponse {
  messageId: string;
  status: "processing";
}

export interface ListMessagesResponse {
  messages: Message[];
}

export interface ReadFileRequest {
  path: string;
  encoding?: "utf-8" | "base64";
}

export interface ReadFileResponse {
  path: string;
  content: string;
  encoding: string;
  size: number;
  mtime: string;
}

export interface ListFilesRequest {
  path?: string;
  recursive?: boolean;
}

export interface ListFilesResponse {
  files: FileInfo[];
}

export interface GetFileTreeRequest {
  path?: string;
  maxDepth?: number;
}

export interface GetFileTreeResponse {
  tree: FileTree;
}

export interface ListToolsResponse {
  tools: Tool[];
  bundles: Record<string, ToolBundle>;
}

export interface LoadToolsRequest {
  tools?: string[];
  bundles?: string[];
}

export interface UnloadToolsRequest {
  tools: string[];
}

export interface GetActiveToolsResponse {
  activeTools: Array<{
    name: string;
    loadedAt: string;
    usageCount: number;
    lastUsed: string;
  }>;
}

export interface UpdateConfigRequest {
  defaultModel?: string;
  maxSessions?: number;
}

// Authentication API types
export interface GetAuthStatusResponse {
  authStatus: AuthStatus;
}

// API client interface
export interface APIClient {
  // Sessions
  createSession(req: CreateSessionRequest): Promise<CreateSessionResponse>;
  listSessions(): Promise<ListSessionsResponse>;
  getSession(sessionId: string): Promise<GetSessionResponse>;
  updateSession(sessionId: string, req: UpdateSessionRequest): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;

  // Messages
  sendMessage(sessionId: string, req: SendMessageRequest): Promise<SendMessageResponse>;
  listMessages(
    sessionId: string,
    params?: {
      limit?: number;
      offset?: number;
      before?: string;
      after?: string;
    },
  ): Promise<ListMessagesResponse>;

  // Files
  readFile(sessionId: string, req: ReadFileRequest): Promise<ReadFileResponse>;
  listFiles(sessionId: string, req: ListFilesRequest): Promise<ListFilesResponse>;
  getFileTree(sessionId: string, req: GetFileTreeRequest): Promise<GetFileTreeResponse>;

  // Tools
  listTools(): Promise<ListToolsResponse>;
  loadTools(sessionId: string, req: LoadToolsRequest): Promise<void>;
  unloadTools(sessionId: string, req: UnloadToolsRequest): Promise<void>;
  getActiveTools(sessionId: string): Promise<GetActiveToolsResponse>;

  // System
  health(): Promise<HealthStatus>;
  getConfig(): Promise<DaemonConfig>;
  updateConfig(req: UpdateConfigRequest): Promise<void>;

  // Authentication
  getAuthStatus(): Promise<GetAuthStatusResponse>;
}
