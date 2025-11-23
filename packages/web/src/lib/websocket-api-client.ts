/**
 * WebSocket-Only API Client
 *
 * Replaces REST API client with RPC over WebSocket.
 * All operations go through the EventBus with request/response pattern.
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
import { RPCManager, EventBus, WebSocketClientTransport } from "@liuboer/shared";

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
 * WebSocket-based API Client using RPC pattern
 *
 * Maintains a global WebSocket connection for system operations
 * and session-specific connections for session operations.
 */
export class WebSocketAPIClient implements APIClient {
  private globalEventBus: EventBus | null = null;
  private globalTransport: WebSocketClientTransport | null = null;
  private globalRPC: RPCManager | null = null;
  private baseUrl: string;
  private connectionPromise: Promise<void> | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || getDaemonWsUrl();
    console.log(`WebSocket API Client initialized with baseUrl: ${this.baseUrl}`);
  }

  /**
   * Ensure global WebSocket connection is established
   */
  private async ensureConnection(): Promise<RPCManager> {
    if (this.globalRPC && this.globalTransport?.isReady()) {
      return this.globalRPC;
    }

    // If already connecting, wait for that
    if (this.connectionPromise) {
      await this.connectionPromise;
      if (this.globalRPC) {
        return this.globalRPC;
      }
    }

    // Start new connection
    this.connectionPromise = this.connect();
    await this.connectionPromise;
    this.connectionPromise = null;

    if (!this.globalRPC) {
      throw new Error("Failed to establish global WebSocket connection");
    }

    return this.globalRPC;
  }

  /**
   * Connect to global WebSocket
   */
  private async connect(): Promise<void> {
    console.log("[WebSocketAPIClient] Connecting to global WebSocket...");

    // Create EventBus for global connection
    this.globalEventBus = new EventBus({ sessionId: "global", debug: false });

    // Create WebSocket transport
    this.globalTransport = new WebSocketClientTransport({
      url: `${this.baseUrl}/ws`,
      sessionId: "global",
      autoReconnect: true,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      pingInterval: 30000,
    });

    // Register transport
    this.globalEventBus.registerTransport(this.globalTransport);

    // Create RPC Manager
    this.globalRPC = new RPCManager(this.globalEventBus, "global");

    // Initialize transport (connect)
    await this.globalTransport.initialize();

    // Wait for connection to be established
    await this.waitForConnection(5000);

    console.log("[WebSocketAPIClient] Global WebSocket connected");
  }

  /**
   * Wait for WebSocket to be ready
   */
  private async waitForConnection(timeout: number): Promise<void> {
    const start = Date.now();

    while (!this.globalTransport?.isReady()) {
      if (Date.now() - start > timeout) {
        throw new Error("WebSocket connection timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Disconnect global WebSocket
   */
  async disconnect(): Promise<void> {
    if (this.globalRPC) {
      this.globalRPC.cleanup();
      this.globalRPC = null;
    }

    if (this.globalEventBus) {
      await this.globalEventBus.close();
      this.globalEventBus = null;
    }

    if (this.globalTransport) {
      await this.globalTransport.close();
      this.globalTransport = null;
    }

    console.log("[WebSocketAPIClient] Disconnected");
  }

  // ==================== Session Operations ====================

  async createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
    const rpc = await this.ensureConnection();
    return await rpc.request<CreateSessionResponse>(
      "session.create.request",
      req,
      { timeout: 15000 },
    );
  }

  async listSessions(): Promise<ListSessionsResponse> {
    const rpc = await this.ensureConnection();
    return await rpc.request<ListSessionsResponse>(
      "session.list.request",
      {},
    );
  }

  async getSession(sessionId: string): Promise<GetSessionResponse> {
    const rpc = await this.ensureConnection();
    return await rpc.request<GetSessionResponse>(
      "session.get.request",
      { sessionId },
    );
  }

  async updateSession(sessionId: string, req: UpdateSessionRequest): Promise<void> {
    const rpc = await this.ensureConnection();
    await rpc.request(
      "session.update.request",
      { sessionId, ...req },
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    const rpc = await this.ensureConnection();
    await rpc.request(
      "session.delete.request",
      { sessionId },
    );
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
    const rpc = await this.ensureConnection();
    return await rpc.request<ListMessagesResponse>(
      "message.list.request",
      { sessionId, ...params },
    );
  }

  async clearMessages(sessionId: string): Promise<void> {
    // TODO: Implement clear messages event
    throw new Error("clearMessages not yet implemented via WebSocket");
  }

  async getSDKMessages(
    sessionId: string,
    params?: {
      limit?: number;
      offset?: number;
      since?: number;
    },
  ): Promise<{ sdkMessages: any[] }> {
    const rpc = await this.ensureConnection();
    return await rpc.request<{ sdkMessages: any[] }>(
      "message.sdkMessages.request",
      { sessionId, ...params },
    );
  }

  // ==================== Command Operations ====================

  async getSlashCommands(sessionId: string): Promise<{ commands: string[] }> {
    const rpc = await this.ensureConnection();
    return await rpc.request<{ commands: string[] }>(
      "commands.list.request",
      { sessionId },
    );
  }

  // ==================== File Operations ====================

  async readFile(sessionId: string, req: ReadFileRequest): Promise<ReadFileResponse> {
    const rpc = await this.ensureConnection();
    return await rpc.request<ReadFileResponse>(
      "file.read.request",
      { sessionId, ...req },
    );
  }

  async listFiles(sessionId: string, req: ListFilesRequest): Promise<ListFilesResponse> {
    const rpc = await this.ensureConnection();
    return await rpc.request<ListFilesResponse>(
      "file.list.request",
      { sessionId, ...req },
    );
  }

  async getFileTree(
    sessionId: string,
    req: GetFileTreeRequest,
  ): Promise<GetFileTreeResponse> {
    const rpc = await this.ensureConnection();
    return await rpc.request<GetFileTreeResponse>(
      "file.tree.request",
      { sessionId, ...req },
    );
  }

  // ==================== Tool Operations ====================

  async listTools(): Promise<ListToolsResponse> {
    // TODO: Implement via WebSocket
    throw new Error("listTools not yet implemented via WebSocket");
  }

  async loadTools(sessionId: string, req: LoadToolsRequest): Promise<void> {
    // TODO: Implement via WebSocket
    throw new Error("loadTools not yet implemented via WebSocket");
  }

  async unloadTools(sessionId: string, req: UnloadToolsRequest): Promise<void> {
    // TODO: Implement via WebSocket
    throw new Error("unloadTools not yet implemented via WebSocket");
  }

  async getActiveTools(sessionId: string): Promise<GetActiveToolsResponse> {
    // TODO: Implement via WebSocket
    throw new Error("getActiveTools not yet implemented via WebSocket");
  }

  // ==================== System Operations ====================

  async health(): Promise<HealthStatus> {
    const rpc = await this.ensureConnection();
    return await rpc.request<HealthStatus>(
      "system.health.request",
      {},
    );
  }

  async getConfig(): Promise<DaemonConfig> {
    const rpc = await this.ensureConnection();
    return await rpc.request<DaemonConfig>(
      "system.config.request",
      {},
    );
  }

  async updateConfig(req: UpdateConfigRequest): Promise<void> {
    // TODO: Implement via WebSocket
    throw new Error("updateConfig not yet implemented via WebSocket");
  }

  // ==================== Authentication ====================

  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    const rpc = await this.ensureConnection();
    return await rpc.request<GetAuthStatusResponse>(
      "auth.status.request",
      {},
    );
  }
}

// Singleton instance
export const websocketApiClient = new WebSocketAPIClient();
