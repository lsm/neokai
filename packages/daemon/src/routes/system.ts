import type { Elysia } from "elysia";
import type { DaemonConfig, HealthStatus } from "@liuboer/shared";
import type { SessionManager } from "../lib/session-manager";
import type { AuthManager } from "../lib/auth-manager";
import type { Config } from "../config";

const VERSION = "0.1.0";
const CLAUDE_SDK_VERSION = "0.1.37"; // TODO: Get dynamically
const startTime = Date.now();

export function createSystemRouter(
  app: Elysia,
  sessionManager: SessionManager,
  config: Config,
  authManager: AuthManager,
) {
  return app
    // Health check
    .get("/api/health", () => {
      const response: HealthStatus = {
        status: "ok",
        version: VERSION,
        uptime: Date.now() - startTime,
        sessions: {
          active: sessionManager.getActiveSessions(),
          total: sessionManager.getTotalSessions(),
        },
      };

      return response;
    })

    // Get config
    .get("/api/config", async () => {
      const authStatus = await authManager.getAuthStatus();

      const response: DaemonConfig = {
        version: VERSION,
        claudeSDKVersion: CLAUDE_SDK_VERSION,
        defaultModel: config.defaultModel,
        maxSessions: config.maxSessions,
        storageLocation: config.dbPath,
        authMethod: authStatus.method,
        authStatus,
      };

      return response;
    });
}
