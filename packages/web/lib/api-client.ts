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
} from "@liuboer/shared";
import type { DaemonConfig, HealthStatus } from "@liuboer/shared";

/**
 * Get the daemon API base URL based on the current hostname
 * Uses the same hostname as the web UI but with port 8283
 */
function getDaemonBaseUrl(): string {
  if (typeof window === 'undefined') {
    return "http://localhost:8283";
  }

  const hostname = window.location.hostname;
  const protocol = window.location.protocol;

  // Use the current hostname with port 8283
  return `${protocol}//${hostname}:8283`;
}

export class DaemonAPIClient implements APIClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || getDaemonBaseUrl();
    console.log(`API Client initialized with baseUrl: ${this.baseUrl}`);
  }

  private async fetch<T>(
    path: string,
    options?: RequestInit,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  // Sessions
  async createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.fetch<CreateSessionResponse>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async listSessions(): Promise<ListSessionsResponse> {
    return this.fetch<ListSessionsResponse>("/api/sessions");
  }

  async getSession(sessionId: string): Promise<GetSessionResponse> {
    return this.fetch<GetSessionResponse>(`/api/sessions/${sessionId}`);
  }

  async updateSession(sessionId: string, req: UpdateSessionRequest): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(req),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}`, {
      method: "DELETE",
    });
  }

  // Messages
  async sendMessage(
    sessionId: string,
    req: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    return this.fetch<SendMessageResponse>(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify(req),
    });
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
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    if (params?.before) queryParams.set("before", params.before);
    if (params?.after) queryParams.set("after", params.after);

    const query = queryParams.toString();
    const path = `/api/sessions/${sessionId}/messages${query ? `?${query}` : ""}`;

    return this.fetch<ListMessagesResponse>(path);
  }

  async clearMessages(sessionId: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}/messages`, {
      method: "DELETE",
    });
  }

  // Files
  async readFile(sessionId: string, req: ReadFileRequest): Promise<ReadFileResponse> {
    const queryParams = new URLSearchParams();
    queryParams.set("path", req.path);
    if (req.encoding) queryParams.set("encoding", req.encoding);

    return this.fetch<ReadFileResponse>(
      `/api/sessions/${sessionId}/files?${queryParams}`,
    );
  }

  async listFiles(sessionId: string, req: ListFilesRequest): Promise<ListFilesResponse> {
    const queryParams = new URLSearchParams();
    if (req.path) queryParams.set("path", req.path);
    if (req.recursive !== undefined) {
      queryParams.set("recursive", req.recursive.toString());
    }

    return this.fetch<ListFilesResponse>(
      `/api/sessions/${sessionId}/files/list?${queryParams}`,
    );
  }

  async getFileTree(
    sessionId: string,
    req: GetFileTreeRequest,
  ): Promise<GetFileTreeResponse> {
    const queryParams = new URLSearchParams();
    if (req.path) queryParams.set("path", req.path);
    if (req.maxDepth !== undefined) queryParams.set("maxDepth", req.maxDepth.toString());

    return this.fetch<GetFileTreeResponse>(
      `/api/sessions/${sessionId}/files/tree?${queryParams}`,
    );
  }

  // Tools
  async listTools(): Promise<ListToolsResponse> {
    return this.fetch<ListToolsResponse>("/api/tools");
  }

  async loadTools(sessionId: string, req: LoadToolsRequest): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}/tools/load`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async unloadTools(sessionId: string, req: UnloadToolsRequest): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}/tools/unload`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async getActiveTools(sessionId: string): Promise<GetActiveToolsResponse> {
    return this.fetch<GetActiveToolsResponse>(`/api/sessions/${sessionId}/tools`);
  }

  // System
  async health(): Promise<HealthStatus> {
    return this.fetch<HealthStatus>("/api/health");
  }

  async getConfig(): Promise<DaemonConfig> {
    return this.fetch<DaemonConfig>("/api/config");
  }

  async updateConfig(req: UpdateConfigRequest): Promise<void> {
    await this.fetch("/api/config", {
      method: "PATCH",
      body: JSON.stringify(req),
    });
  }

  // Authentication
  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    return this.fetch<GetAuthStatusResponse>("/api/auth/status");
  }
}

// Singleton instance
export const apiClient = new DaemonAPIClient();
