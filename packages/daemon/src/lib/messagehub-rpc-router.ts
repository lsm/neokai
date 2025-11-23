/**
 * MessageHub RPC Router
 *
 * Simplified RPC router using MessageHub's bidirectional RPC pattern.
 * Replaces WebSocketRPCRouter's event-based pattern with direct RPC.
 */

import type { MessageHub } from "@liuboer/shared";
import type { SessionManager } from "./session-manager";
import type { AuthManager } from "./auth-manager";
import type { Config } from "../config";
import type {
  CreateSessionRequest,
  UpdateSessionRequest,
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

export class MessageHubRPCRouter {
  constructor(
    private messageHub: MessageHub,
    private sessionManager: SessionManager,
    private authManager: AuthManager,
    private config: Config,
  ) {}

  /**
   * Setup all RPC handlers on MessageHub
   */
  setupHandlers(): void {
    // Session operations
    this.messageHub.handle("session.create", async (data) => {
      const req = data as CreateSessionRequest;
      const sessionId = await this.sessionManager.createSession({
        workspacePath: req.workspacePath,
        initialTools: req.initialTools,
        config: req.config,
      });
      return { sessionId };
    });

    this.messageHub.handle("session.list", async () => {
      const sessions = this.sessionManager.listSessions();
      return { sessions };
    });

    this.messageHub.handle("session.get", async (data) => {
      const { sessionId: targetSessionId } = data as { sessionId: string };
      const agentSession = this.sessionManager.getSession(targetSessionId);

      if (!agentSession) {
        throw new Error("Session not found");
      }

      const session = agentSession.getSessionData();
      const messages = agentSession.getMessages();

      return {
        session,
        messages,
        activeTools: [],
        context: {
          files: [],
          workingDirectory: session.workspacePath,
        },
      };
    });

    this.messageHub.handle("session.update", async (data, ctx) => {
      const { sessionId: targetSessionId, ...updates } = data as
        & UpdateSessionRequest
        & { sessionId: string };

      await this.sessionManager.updateSession(targetSessionId, updates);

      // Broadcast update event to all clients
      await this.messageHub.publish("session.updated", updates, {
        sessionId: targetSessionId,
      });

      return { success: true };
    });

    this.messageHub.handle("session.delete", async (data, ctx) => {
      const { sessionId: targetSessionId } = data as { sessionId: string };
      await this.sessionManager.deleteSession(targetSessionId);

      // Broadcast deletion event to all clients
      await this.messageHub.publish("session.deleted", {}, {
        sessionId: targetSessionId,
      });

      return { success: true };
    });

    // Message operations
    this.messageHub.handle("message.list", async (data) => {
      const { sessionId: targetSessionId } = data as { sessionId: string };
      const agentSession = this.sessionManager.getSession(targetSessionId);

      if (!agentSession) {
        throw new Error("Session not found");
      }

      const messages = agentSession.getMessages();
      return { messages };
    });

    this.messageHub.handle("message.sdkMessages", async (data) => {
      const { sessionId: targetSessionId, limit, offset, since } = data as {
        sessionId: string;
        limit?: number;
        offset?: number;
        since?: number;
      };

      const agentSession = this.sessionManager.getSession(targetSessionId);

      if (!agentSession) {
        throw new Error("Session not found");
      }

      const sdkMessages = agentSession.getSDKMessages(limit, offset, since);
      return { sdkMessages };
    });

    // Command operations
    this.messageHub.handle("commands.list", async (data) => {
      const { sessionId: targetSessionId } = data as { sessionId: string };
      const agentSession = this.sessionManager.getSession(targetSessionId);

      if (!agentSession) {
        throw new Error("Session not found");
      }

      const commands = await agentSession.getSlashCommands();
      return { commands };
    });

    // File operations
    this.messageHub.handle("file.read", async (data) => {
      const { sessionId: targetSessionId, path, encoding } = data as
        & ReadFileRequest
        & { sessionId: string };

      const agentSession = this.sessionManager.getSession(targetSessionId);
      if (!agentSession) {
        throw new Error("Session not found");
      }

      const fileManager = new FileManager(
        agentSession.getSessionData().workspacePath,
      );
      const fileData = await fileManager.readFile(
        path,
        encoding as "utf-8" | "base64",
      );

      return fileData;
    });

    this.messageHub.handle("file.list", async (data) => {
      const { sessionId: targetSessionId, path, recursive } = data as
        & ListFilesRequest
        & { sessionId: string };

      const agentSession = this.sessionManager.getSession(targetSessionId);
      if (!agentSession) {
        throw new Error("Session not found");
      }

      const fileManager = new FileManager(
        agentSession.getSessionData().workspacePath,
      );
      const files = await fileManager.listDirectory(path || ".", recursive);

      return { files };
    });

    this.messageHub.handle("file.tree", async (data) => {
      const { sessionId: targetSessionId, path, maxDepth } = data as
        & GetFileTreeRequest
        & { sessionId: string };

      const agentSession = this.sessionManager.getSession(targetSessionId);
      if (!agentSession) {
        throw new Error("Session not found");
      }

      const fileManager = new FileManager(
        agentSession.getSessionData().workspacePath,
      );
      const tree = await fileManager.getFileTree(path || ".", maxDepth || 3);

      return { tree };
    });

    // System operations
    this.messageHub.handle("system.health", async () => {
      const response: HealthStatus = {
        status: "ok",
        version: VERSION,
        uptime: Date.now() - startTime,
        sessions: {
          active: this.sessionManager.getActiveSessions(),
          total: this.sessionManager.getTotalSessions(),
        },
      };

      return response;
    });

    this.messageHub.handle("system.config", async () => {
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

      return response;
    });

    // Auth operations
    this.messageHub.handle("auth.status", async () => {
      const authStatus = await this.authManager.getAuthStatus();
      return { authStatus };
    });
  }
}
