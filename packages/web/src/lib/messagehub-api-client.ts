/**
 * MessageHub API Client
 *
 * Replaces WebSocket RPC with MessageHub protocol.
 * Simpler, cleaner API with bidirectional RPC and Pub/Sub.
 */

import type {
  APIClient,
  CreateSessionRequest,
  CreateSessionResponse,
  GetActiveToolsResponse,
  GetAuthStatusResponse,
  GetFileTreeRequest,
  GetFileTreeResponse,
  GetSessionResponse,
  ListFilesRequest,
  ListFilesResponse,
  ListMessagesResponse,
  ListSessionsResponse,
  ListToolsResponse,
  LoadToolsRequest,
  ReadFileRequest,
  ReadFileResponse,
  SendMessageRequest,
  SendMessageResponse,
  UnloadToolsRequest,
  UpdateConfigRequest,
  UpdateSessionRequest,
  DaemonConfig,
  HealthStatus,
} from "@liuboer/shared";
import { MessageHub, HubWebSocketClientTransport } from "@liuboer/shared";

/**
 * Get the daemon WebSocket base URL
 */
function getDaemonWsUrl(): string {
  if (typeof window === "undefined") {
    return "ws://localhost:8283";
  }

  const hostname = window.location.hostname;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  return `${protocol}//${hostname}:8283`;
}

/**
 * MessageHub-based API Client
 *
 * Uses MessageHub protocol for all operations.
 * Much simpler than the old EventBus + RPCManager pattern.
 */
export class MessageHubAPIClient implements APIClient {
  private messageHub: MessageHub | null = null;
  private transport: HubWebSocketClientTransport | null = null;
  private baseUrl: string;
  private connectionPromise: Promise<void> | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || getDaemonWsUrl();
    console.log(`[MessageHub] API Client initialized with baseUrl: ${this.baseUrl}`);
  }

  /**
   * Ensure MessageHub connection is established
   */
  private async ensureConnection(): Promise<MessageHub> {
    if (this.messageHub && this.transport?.isReady()) {
      return this.messageHub;
    }

    // If already connecting, wait for that
    if (this.connectionPromise) {
      await this.connectionPromise;
      if (this.messageHub) {
        return this.messageHub;
      }
    }

    // Start new connection
    this.connectionPromise = this.connect();
    await this.connectionPromise;
    this.connectionPromise = null;

    if (!this.messageHub) {
      throw new Error("Failed to establish MessageHub connection");
    }

    return this.messageHub;
  }

  /**
   * Connect to global WebSocket with MessageHub
   */
  private async connect(): Promise<void> {
    console.log("[MessageHub] Connecting to WebSocket...");

    // Create MessageHub
    this.messageHub = new MessageHub({
      defaultSessionId: "global",
      debug: false,
    });

    // Create WebSocket transport
    this.transport = new HubWebSocketClientTransport({
      url: `${this.baseUrl}/ws`,
      autoReconnect: true,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      pingInterval: 30000,
    });

    // Register transport
    this.messageHub.registerTransport(this.transport);

    // Initialize transport (establishes WebSocket connection)
    await this.transport.initialize();

    // Wait for connection to be established
    await this.waitForConnection(5000);

    console.log("[MessageHub] WebSocket connected");
  }

  /**
   * Wait for WebSocket to be ready
   */
  private async waitForConnection(timeout: number): Promise<void> {
    const start = Date.now();

    while (!this.messageHub?.isConnected()) {
      if (Date.now() - start > timeout) {
        throw new Error("WebSocket connection timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Disconnect from WebSocket
   */
  async disconnect(): Promise<void> {
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }

    this.messageHub = null;

    console.log("[MessageHub] Disconnected");
  }

  // ==================== Session Operations ====================

  async createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
    const hub = await this.ensureConnection();
    return await hub.call<CreateSessionResponse>("session.create", req, {
      timeout: 15000,
    });
  }

  async listSessions(): Promise<ListSessionsResponse> {
    const hub = await this.ensureConnection();
    return await hub.call<ListSessionsResponse>("session.list");
  }

  async getSession(sessionId: string): Promise<GetSessionResponse> {
    const hub = await this.ensureConnection();
    return await hub.call<GetSessionResponse>("session.get", { sessionId });
  }

  async updateSession(sessionId: string, req: UpdateSessionRequest): Promise<void> {
    const hub = await this.ensureConnection();
    await hub.call("session.update", { sessionId, ...req });
  }

  async deleteSession(sessionId: string): Promise<void> {
    const hub = await this.ensureConnection();
    await hub.call("session.delete", { sessionId });
  }

  // ==================== Message Operations ====================

  async sendMessage(
    sessionId: string,
    req: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    // NOTE: This still uses the existing event-based pattern via session EventBus
    // The eventBusClient handles this
    throw new Error("Use eventBusClient.emit() with message.send event instead");
  }

  async listMessages(
    sessionId: string,
    params?: {
      limit?: number;
      offset?: number;
      before?: string;
      after?: string;
    },
  ): Promise<ListMessagesResponse> {
    const hub = await this.ensureConnection();
    return await hub.call<ListMessagesResponse>("message.list", {
      sessionId,
      ...params,
    });
  }

  async clearMessages(sessionId: string): Promise<void> {
    // TODO: Implement clear messages
    throw new Error("clearMessages not yet implemented");
  }

  async getSDKMessages(
    sessionId: string,
    params?: {
      limit?: number;
      offset?: number;
      since?: number;
    },
  ): Promise<{ sdkMessages: any[] }> {
    const hub = await this.ensureConnection();
    return await hub.call<{ sdkMessages: any[] }>("message.sdkMessages", {
      sessionId,
      ...params,
    });
  }

  // ==================== Command Operations ====================

  async getSlashCommands(sessionId: string): Promise<{ commands: string[] }> {
    const hub = await this.ensureConnection();
    return await hub.call<{ commands: string[] }>("commands.list", { sessionId });
  }

  // ==================== File Operations ====================

  async readFile(sessionId: string, req: ReadFileRequest): Promise<ReadFileResponse> {
    const hub = await this.ensureConnection();
    return await hub.call<ReadFileResponse>("file.read", {
      sessionId,
      ...req,
    });
  }

  async listFiles(sessionId: string, req: ListFilesRequest): Promise<ListFilesResponse> {
    const hub = await this.ensureConnection();
    return await hub.call<ListFilesResponse>("file.list", {
      sessionId,
      ...req,
    });
  }

  async getFileTree(
    sessionId: string,
    req: GetFileTreeRequest,
  ): Promise<GetFileTreeResponse> {
    const hub = await this.ensureConnection();
    return await hub.call<GetFileTreeResponse>("file.tree", {
      sessionId,
      ...req,
    });
  }

  // ==================== Tool Operations ====================

  async listTools(): Promise<ListToolsResponse> {
    throw new Error("listTools not yet implemented");
  }

  async loadTools(sessionId: string, req: LoadToolsRequest): Promise<void> {
    throw new Error("loadTools not yet implemented");
  }

  async unloadTools(sessionId: string, req: UnloadToolsRequest): Promise<void> {
    throw new Error("unloadTools not yet implemented");
  }

  async getActiveTools(sessionId: string): Promise<GetActiveToolsResponse> {
    throw new Error("getActiveTools not yet implemented");
  }

  // ==================== System Operations ====================

  async health(): Promise<HealthStatus> {
    const hub = await this.ensureConnection();
    return await hub.call<HealthStatus>("system.health");
  }

  async getConfig(): Promise<DaemonConfig> {
    const hub = await this.ensureConnection();
    return await hub.call<DaemonConfig>("system.config");
  }

  async updateConfig(req: UpdateConfigRequest): Promise<void> {
    throw new Error("updateConfig not yet implemented");
  }

  // ==================== Authentication ====================

  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    const hub = await this.ensureConnection();
    return await hub.call<GetAuthStatusResponse>("auth.status");
  }

  // ==================== MessageHub-specific Methods ====================

  /**
   * Subscribe to events (MessageHub Pub/Sub)
   */
  subscribe<T>(eventPattern: string, handler: (data: T) => void): () => void {
    if (!this.messageHub) {
      throw new Error("MessageHub not connected");
    }
    return this.messageHub.subscribe(eventPattern, handler);
  }

  /**
   * Get the underlying MessageHub instance for advanced usage
   */
  getMessageHub(): MessageHub | null {
    return this.messageHub;
  }
}

// Singleton instance
export const messageHubApiClient = new MessageHubAPIClient();
