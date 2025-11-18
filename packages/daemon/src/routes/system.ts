import { Router } from "@oak/oak";
import type { DaemonConfig, HealthStatus } from "@liuboer/shared";
import { SessionManager } from "../lib/session-manager.ts";
import type { AuthManager } from "../lib/auth-manager.ts";
import type { Config } from "../config.ts";

const VERSION = "0.1.0";
const CLAUDE_SDK_VERSION = "0.1.37"; // TODO: Get dynamically
const startTime = Date.now();

export function createSystemRouter(
  sessionManager: SessionManager,
  config: Config,
  authManager: AuthManager,
): Router {
  const router = new Router();

  // Health check
  router.get("/api/health", (ctx) => {
    const response: HealthStatus = {
      status: "ok",
      version: VERSION,
      uptime: Date.now() - startTime,
      sessions: {
        active: sessionManager.getActiveSessions(),
        total: sessionManager.getTotalSessions(),
      },
    };

    ctx.response.body = response;
  });

  // Get config
  router.get("/api/config", async (ctx) => {
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

    ctx.response.body = response;
  });

  return router;
}
