/**
 * WebSocket RPC Router
 *
 * Central handler for all request/response events over WebSocket.
 * Replaces REST routes with event-based RPC.
 */

import type { Event } from "@liuboer/shared";
import type { RPCManager } from "@liuboer/shared";
import type { SessionManager } from "./session-manager";
import type { AuthManager } from "./auth-manager";
import type { Config } from "../config";
import type {
  CreateSessionRequest,
  UpdateSessionRequest,
  SendMessageRequest,
  ReadFileRequest,
  ListFilesRequest,
  GetFileTreeRequest,
  HealthStatus,
  DaemonConfig,
} from "@liuboer/shared";
import { FileManager } from "./file-manager";

const VERSION = "0.1.0";
const CLAUDE_SDK_VERSION = "0.1.37"; // TODO: Get dynamically
const startTime = Date.now();

export class WebSocketRPCRouter {
  constructor(
    private sessionManager: SessionManager,
    private authManager: AuthManager,
    private config: Config,
  ) {}

  /**
   * Setup all request event handlers on the global EventBus
   */
  setupHandlers(rpcManager: RPCManager, sessionId: string): void {
    const eventBus = rpcManager.getEventBus();

    // Session operations
    eventBus.on("session.create.request", (event) =>
      this.handleSessionCreate(rpcManager, event),
    );
    eventBus.on("session.list.request", (event) =>
      this.handleSessionList(rpcManager, event),
    );
    eventBus.on("session.get.request", (event) =>
      this.handleSessionGet(rpcManager, event),
    );
    eventBus.on("session.update.request", (event) =>
      this.handleSessionUpdate(rpcManager, event),
    );
    eventBus.on("session.delete.request", (event) =>
      this.handleSessionDelete(rpcManager, event),
    );

    // Message operations
    eventBus.on("message.list.request", (event) =>
      this.handleMessageList(rpcManager, event),
    );
    eventBus.on("message.sdkMessages.request", (event) =>
      this.handleSDKMessagesList(rpcManager, event),
    );

    // File operations
    eventBus.on("file.read.request", (event) =>
      this.handleFileRead(rpcManager, event),
    );
    eventBus.on("file.list.request", (event) =>
      this.handleFileList(rpcManager, event),
    );
    eventBus.on("file.tree.request", (event) =>
      this.handleFileTree(rpcManager, event),
    );

    // System operations
    eventBus.on("system.health.request", (event) =>
      this.handleSystemHealth(rpcManager, event),
    );
    eventBus.on("system.config.request", (event) =>
      this.handleSystemConfig(rpcManager, event),
    );

    // Auth operations
    eventBus.on("auth.status.request", (event) =>
      this.handleAuthStatus(rpcManager, event),
    );
  }

  /**
   * Session: Create
   */
  private async handleSessionCreate(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const req = event.data as CreateSessionRequest;
      const sessionId = await this.sessionManager.createSession({
        workspacePath: req.workspacePath,
        initialTools: req.initialTools,
        config: req.config,
      });

      await rpcManager.respond(
        event.id,
        "session.create.response",
        event.sessionId,
        { sessionId },
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "session.create.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Session: List
   */
  private async handleSessionList(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const sessions = this.sessionManager.listSessions();
      await rpcManager.respond(
        event.id,
        "session.list.response",
        event.sessionId,
        { sessions },
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "session.list.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Session: Get
   */
  private async handleSessionGet(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const { sessionId: targetSessionId } = event.data as { sessionId: string };
      const agentSession = this.sessionManager.getSession(targetSessionId);

      if (!agentSession) {
        await rpcManager.respond(
          event.id,
          "session.get.response",
          event.sessionId,
          undefined,
          "Session not found",
        );
        return;
      }

      const session = agentSession.getSessionData();
      const messages = agentSession.getMessages();

      await rpcManager.respond(
        event.id,
        "session.get.response",
        event.sessionId,
        {
          session,
          messages,
          activeTools: [],
          context: {
            files: [],
            workingDirectory: session.workspacePath,
          },
        },
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "session.get.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Session: Update
   */
  private async handleSessionUpdate(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const { sessionId: targetSessionId, ...updates } = event.data as
        & UpdateSessionRequest
        & { sessionId: string };

      await this.sessionManager.updateSession(targetSessionId, updates);

      // Respond to requester
      await rpcManager.respond(
        event.id,
        "session.update.response",
        event.sessionId,
        { success: true },
      );

      // Broadcast to all clients
      const eventBus = rpcManager.getEventBus();
      await eventBus.emit({
        id: crypto.randomUUID(),
        type: "session.updated",
        sessionId: targetSessionId,
        timestamp: new Date().toISOString(),
        data: updates,
      });
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "session.update.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Session: Delete
   */
  private async handleSessionDelete(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const { sessionId: targetSessionId } = event.data as { sessionId: string };
      await this.sessionManager.deleteSession(targetSessionId);

      // Respond to requester
      await rpcManager.respond(
        event.id,
        "session.delete.response",
        event.sessionId,
        { success: true },
      );

      // Broadcast to all clients
      const eventBus = rpcManager.getEventBus();
      await eventBus.emit({
        id: crypto.randomUUID(),
        type: "session.deleted",
        sessionId: targetSessionId,
        timestamp: new Date().toISOString(),
        data: {},
      });
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "session.delete.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Message: List
   */
  private async handleMessageList(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const { sessionId: targetSessionId } = event.data as { sessionId: string };
      const agentSession = this.sessionManager.getSession(targetSessionId);

      if (!agentSession) {
        await rpcManager.respond(
          event.id,
          "message.list.response",
          event.sessionId,
          undefined,
          "Session not found",
        );
        return;
      }

      const messages = agentSession.getMessages();
      await rpcManager.respond(
        event.id,
        "message.list.response",
        event.sessionId,
        { messages },
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "message.list.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Message: Get SDK Messages
   */
  private async handleSDKMessagesList(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const { sessionId: targetSessionId, limit, offset, since } = event.data as {
        sessionId: string;
        limit?: number;
        offset?: number;
        since?: number;
      };

      const agentSession = this.sessionManager.getSession(targetSessionId);

      if (!agentSession) {
        await rpcManager.respond(
          event.id,
          "message.sdkMessages.response",
          event.sessionId,
          undefined,
          "Session not found",
        );
        return;
      }

      const sdkMessages = agentSession.getSDKMessages(limit, offset, since);
      await rpcManager.respond(
        event.id,
        "message.sdkMessages.response",
        event.sessionId,
        { sdkMessages },
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "message.sdkMessages.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * File: Read
   */
  private async handleFileRead(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const { sessionId: targetSessionId, path, encoding } = event.data as
        & ReadFileRequest
        & { sessionId: string };

      const agentSession = this.sessionManager.getSession(targetSessionId);
      if (!agentSession) {
        await rpcManager.respond(
          event.id,
          "file.read.response",
          event.sessionId,
          undefined,
          "Session not found",
        );
        return;
      }

      const fileManager = new FileManager(
        agentSession.getSessionData().workspacePath,
      );
      const fileData = await fileManager.readFile(
        path,
        encoding as "utf-8" | "base64",
      );

      await rpcManager.respond(
        event.id,
        "file.read.response",
        event.sessionId,
        fileData,
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "file.read.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * File: List
   */
  private async handleFileList(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const { sessionId: targetSessionId, path, recursive } = event.data as
        & ListFilesRequest
        & { sessionId: string };

      const agentSession = this.sessionManager.getSession(targetSessionId);
      if (!agentSession) {
        await rpcManager.respond(
          event.id,
          "file.list.response",
          event.sessionId,
          undefined,
          "Session not found",
        );
        return;
      }

      const fileManager = new FileManager(
        agentSession.getSessionData().workspacePath,
      );
      const files = await fileManager.listDirectory(path || ".", recursive);

      await rpcManager.respond(
        event.id,
        "file.list.response",
        event.sessionId,
        { files },
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "file.list.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * File: Tree
   */
  private async handleFileTree(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const { sessionId: targetSessionId, path, maxDepth } = event.data as
        & GetFileTreeRequest
        & { sessionId: string };

      const agentSession = this.sessionManager.getSession(targetSessionId);
      if (!agentSession) {
        await rpcManager.respond(
          event.id,
          "file.tree.response",
          event.sessionId,
          undefined,
          "Session not found",
        );
        return;
      }

      const fileManager = new FileManager(
        agentSession.getSessionData().workspacePath,
      );
      const tree = await fileManager.getFileTree(path || ".", maxDepth || 3);

      await rpcManager.respond(
        event.id,
        "file.tree.response",
        event.sessionId,
        { tree },
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "file.tree.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * System: Health
   */
  private async handleSystemHealth(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const response: HealthStatus = {
        status: "ok",
        version: VERSION,
        uptime: Date.now() - startTime,
        sessions: {
          active: this.sessionManager.getActiveSessions(),
          total: this.sessionManager.getTotalSessions(),
        },
      };

      await rpcManager.respond(
        event.id,
        "system.health.response",
        event.sessionId,
        response,
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "system.health.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * System: Config
   */
  private async handleSystemConfig(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const authStatus = await this.authManager.getAuthStatus();

      const response: DaemonConfig = {
        version: VERSION,
        claudeSDKVersion: CLAUDE_SDK_VERSION,
        defaultModel: this.config.defaultModel,
        maxSessions: this.config.maxSessions,
        storageLocation: this.config.dbPath,
        authMethod: authStatus.method,
        authStatus,
      };

      await rpcManager.respond(
        event.id,
        "system.config.response",
        event.sessionId,
        response,
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "system.config.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Auth: Status
   */
  private async handleAuthStatus(
    rpcManager: RPCManager,
    event: Event,
  ): Promise<void> {
    try {
      const authStatus = await this.authManager.getAuthStatus();
      await rpcManager.respond(
        event.id,
        "auth.status.response",
        event.sessionId,
        { authStatus },
      );
    } catch (error) {
      await rpcManager.respond(
        event.id,
        "auth.status.response",
        event.sessionId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
