/**
 * File Routes - File system operations endpoints
 *
 * Provides REST API for reading files, listing directories, and getting file trees.
 */

import type { Elysia } from "elysia";
import type { SessionManager } from "../lib/session-manager";
import { FileManager } from "../lib/file-manager";

export function createFilesRouter(app: Elysia, sessionManager: SessionManager) {
  return app
    /**
     * GET /api/sessions/:sessionId/files - Read file content
     */
    .get("/api/sessions/:sessionId/files", async ({ params, query, set }) => {
      const sessionId = params.sessionId;
      const session = sessionManager.getSession(sessionId);

      if (!session) {
        set.status = 404;
        return { error: `Session ${sessionId} not found` };
      }

      const path = (query as any).path;
      if (!path) {
        set.status = 400;
        return { error: "path query parameter is required" };
      }

      const encoding = ((query as any).encoding || "utf-8") as "utf-8" | "base64";

      try {
        const fileManager = new FileManager(session.getSessionData().workspacePath);
        const fileData = await fileManager.readFile(path, encoding);

        return fileData;
      } catch (error) {
        set.status = 500;
        return {
          error: error instanceof Error ? error.message : "Failed to read file",
        };
      }
    })

    /**
     * GET /api/sessions/:sessionId/files/list - List directory contents
     */
    .get("/api/sessions/:sessionId/files/list", async ({ params, query, set }) => {
      const sessionId = params.sessionId;
      const session = sessionManager.getSession(sessionId);

      if (!session) {
        set.status = 404;
        return { error: `Session ${sessionId} not found` };
      }

      const path = (query as any).path || ".";
      const recursive = (query as any).recursive === "true";

      try {
        const fileManager = new FileManager(session.getSessionData().workspacePath);
        const files = await fileManager.listDirectory(path, recursive);

        return { files };
      } catch (error) {
        set.status = 500;
        return {
          error: error instanceof Error ? error.message : "Failed to list directory",
        };
      }
    })

    /**
     * GET /api/sessions/:sessionId/files/tree - Get file tree
     */
    .get("/api/sessions/:sessionId/files/tree", async ({ params, query, set }) => {
      const sessionId = params.sessionId;
      const session = sessionManager.getSession(sessionId);

      if (!session) {
        set.status = 404;
        return { error: `Session ${sessionId} not found` };
      }

      const path = (query as any).path || ".";
      const maxDepth = parseInt((query as any).maxDepth || "3");

      try {
        const fileManager = new FileManager(session.getSessionData().workspacePath);
        const tree = await fileManager.getFileTree(path, maxDepth);

        return { tree };
      } catch (error) {
        set.status = 500;
        return {
          error: error instanceof Error ? error.message : "Failed to get file tree",
        };
      }
    });
}
