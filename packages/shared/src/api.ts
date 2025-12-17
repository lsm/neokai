import type {
	AuthStatus,
	DaemonConfig,
	FileInfo,
	FileTree,
	HealthStatus,
	Session,
	SessionConfig,
	Tool,
	ToolBundle,
	WorktreeCommitStatus,
} from './types.ts';

// Request types
export interface CreateSessionRequest {
	workspacePath?: string;
	initialTools?: string[];
	config?: Partial<SessionConfig>;
	useWorktree?: boolean; // Enable worktree isolation (auto-detected if in git repo)
	worktreeBaseBranch?: string; // Base branch for worktree (default: HEAD)
}

export interface CreateSessionResponse {
	sessionId: string;
	session?: Session; // Optionally include the full session for optimistic updates
}

export interface ListSessionsResponse {
	sessions: Session[];
}

export interface GetSessionResponse {
	session: Session;
	activeTools: string[];
	context: {
		files: string[];
		workingDirectory: string;
	};
}

export interface UpdateSessionRequest {
	title?: string;
	workspacePath?: string;
	config?: Partial<SessionConfig>;
}

export interface ArchiveSessionRequest {
	sessionId: string;
	confirmed?: boolean;
}

export interface ArchiveSessionResponse {
	success: boolean;
	requiresConfirmation: boolean;
	commitStatus?: WorktreeCommitStatus;
	commitsRemoved?: number;
}

export interface SendMessageRequest {
	content: string;
	role?: 'user';
	attachments?: {
		files?: string[];
		images?: string[];
	};
}

export interface SendMessageResponse {
	messageId: string;
	status: 'processing';
}

export interface ReadFileRequest {
	path: string;
	encoding?: 'utf-8' | 'base64';
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

// Model API types
export interface GetCurrentModelRequest {
	sessionId: string;
}

export interface GetCurrentModelResponse {
	currentModel: string;
	modelInfo: {
		id: string;
		name: string;
		alias: string;
		family: 'opus' | 'sonnet' | 'haiku';
		contextWindow: number;
		description: string;
	} | null;
}

export interface SwitchModelRequest {
	sessionId: string;
	model: string; // Can be alias (e.g., "opus") or full ID
}

export interface SwitchModelResponse {
	success: boolean;
	model: string; // The resolved model ID
	error?: string;
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
	clearMessages(sessionId: string): Promise<void>;

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

	// Models
	getCurrentModel(sessionId: string): Promise<GetCurrentModelResponse>;
	switchModel(sessionId: string, model: string): Promise<SwitchModelResponse>;
}
