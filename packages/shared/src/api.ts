import type {
	AuthStatus,
	DaemonConfig,
	FileInfo,
	FileTree,
	HealthStatus,
	Provider,
	ProviderInfo,
	Session,
	SessionConfig,
	Tool,
	ToolBundle,
	WorktreeCommitStatus,
	// SDK Config types
	SDKConfig,
	SystemPromptConfig,
	ToolsSettings,
	AgentDefinition,
	SandboxSettings,
	McpServerConfig,
	OutputFormatConfig,
	SdkBeta,
	EnvironmentSettings,
	ModelSettings,
	ConfigUpdateResult,
} from './types.ts';
import type { PermissionMode } from './types/settings.ts';

// Request types
export interface CreateSessionRequest {
	workspacePath?: string;
	initialTools?: string[];
	config?: Partial<SessionConfig>;
	useWorktree?: boolean; // Enable worktree isolation (auto-detected if in git repo)
	worktreeBaseBranch?: string; // Base branch for worktree (default: HEAD)
	title?: string; // Optional title - if provided, skips auto-title generation
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
		family: 'opus' | 'sonnet' | 'haiku' | 'glm';
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

// ============================================================================
// SDK Config API Types
// ============================================================================

// --- Model Settings ---

export interface GetModelSettingsRequest {
	sessionId: string;
}

export interface GetModelSettingsResponse extends ModelSettings {
	// Inherits: model, fallbackModel, maxTurns, maxBudgetUsd, maxThinkingTokens
}

export interface UpdateModelSettingsRequest {
	sessionId: string;
	settings: Partial<ModelSettings>;
}

export interface UpdateModelSettingsResponse extends ConfigUpdateResult {
	// Inherits: applied, pending, errors
}

// --- System Prompt ---

export interface GetSystemPromptRequest {
	sessionId: string;
}

export interface GetSystemPromptResponse {
	systemPrompt?: SystemPromptConfig;
}

export interface UpdateSystemPromptRequest {
	sessionId: string;
	systemPrompt: SystemPromptConfig;
	restartQuery?: boolean;
}

export interface UpdateSystemPromptResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Tools Configuration ---

export interface GetToolsConfigRequest {
	sessionId: string;
}

export interface GetToolsConfigResponse extends ToolsSettings {
	// Inherits: tools, allowedTools, disallowedTools
}

export interface UpdateToolsConfigRequest {
	sessionId: string;
	settings: Partial<ToolsSettings>;
	restartQuery?: boolean;
}

export interface UpdateToolsConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Agents/Subagents ---

export interface GetAgentsConfigRequest {
	sessionId: string;
}

export interface GetAgentsConfigResponse {
	agents?: Record<string, AgentDefinition>;
}

export interface UpdateAgentsConfigRequest {
	sessionId: string;
	agents: Record<string, AgentDefinition>;
	restartQuery?: boolean;
}

export interface UpdateAgentsConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Sandbox ---

export interface GetSandboxConfigRequest {
	sessionId: string;
}

export interface GetSandboxConfigResponse {
	sandbox?: SandboxSettings;
}

export interface UpdateSandboxConfigRequest {
	sessionId: string;
	sandbox: SandboxSettings;
	restartQuery?: boolean;
}

export interface UpdateSandboxConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- MCP Servers ---

export interface McpServerStatus {
	name: string;
	status: 'connected' | 'disconnected' | 'error';
	error?: string;
}

export interface GetMcpConfigRequest {
	sessionId: string;
}

export interface GetMcpConfigResponse {
	mcpServers?: Record<string, McpServerConfig>;
	strictMcpConfig?: boolean;
	runtimeStatus?: McpServerStatus[];
}

export interface UpdateMcpConfigRequest {
	sessionId: string;
	mcpServers?: Record<string, McpServerConfig>;
	strictMcpConfig?: boolean;
	restartQuery?: boolean;
}

export interface UpdateMcpConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

export interface AddMcpServerRequest {
	sessionId: string;
	name: string;
	config: McpServerConfig;
	restartQuery?: boolean;
}

export interface AddMcpServerResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

export interface RemoveMcpServerRequest {
	sessionId: string;
	name: string;
	restartQuery?: boolean;
}

export interface RemoveMcpServerResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Output Format ---

export interface GetOutputFormatRequest {
	sessionId: string;
}

export interface GetOutputFormatResponse {
	outputFormat?: OutputFormatConfig;
}

export interface UpdateOutputFormatRequest {
	sessionId: string;
	outputFormat: OutputFormatConfig | null;
	restartQuery?: boolean;
}

export interface UpdateOutputFormatResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Beta Features ---

export interface GetBetasConfigRequest {
	sessionId: string;
}

export interface GetBetasConfigResponse {
	betas: SdkBeta[];
}

export interface UpdateBetasConfigRequest {
	sessionId: string;
	betas: SdkBeta[];
	restartQuery?: boolean;
}

export interface UpdateBetasConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Environment Settings ---

export interface GetEnvConfigRequest {
	sessionId: string;
}

export interface GetEnvConfigResponse extends EnvironmentSettings {
	// Inherits: cwd, additionalDirectories, env, executable, executableArgs
}

export interface UpdateEnvConfigRequest {
	sessionId: string;
	settings: Partial<EnvironmentSettings>;
	restartQuery?: boolean;
}

export interface UpdateEnvConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
	message?: string;
}

// --- Permissions ---

export interface GetPermissionsConfigRequest {
	sessionId: string;
}

export interface GetPermissionsConfigResponse {
	permissionMode?: PermissionMode;
	allowDangerouslySkipPermissions?: boolean;
}

export interface UpdatePermissionsConfigRequest {
	sessionId: string;
	permissionMode: PermissionMode;
}

export interface UpdatePermissionsConfigResponse {
	success: boolean;
	applied: boolean;
	error?: string;
}

// --- Bulk Configuration ---

export interface GetAllConfigRequest {
	sessionId: string;
}

export interface GetAllConfigResponse {
	config: SessionConfig;
}

export interface UpdateBulkConfigRequest {
	sessionId: string;
	config: Partial<SDKConfig>;
	restartQuery?: boolean;
}

export interface UpdateBulkConfigResponse extends ConfigUpdateResult {
	// Inherits: applied, pending, errors
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

	// Providers
	listProviders(): Promise<ListProvidersResponse>;
	getSessionProvider(sessionId: string): Promise<GetSessionProviderResponse>;
	switchProvider(
		sessionId: string,
		provider: Provider,
		apiKey?: string
	): Promise<SwitchProviderResponse>;
}

// ============================================================================
// Provider API Types
// ============================================================================

export interface ListProvidersResponse {
	providers: ProviderInfo[];
}

export interface GetSessionProviderRequest {
	sessionId: string;
}

export interface GetSessionProviderResponse {
	provider: Provider;
	providerInfo: ProviderInfo | null;
}

export interface SwitchProviderRequest {
	sessionId: string;
	provider: Provider;
	/** Optional per-session API key (uses global env var if not provided) */
	apiKey?: string;
}

export interface SwitchProviderResponse {
	success: boolean;
	provider: Provider;
	error?: string;
	/** Warning about query restart requirement */
	warning?: string;
}
