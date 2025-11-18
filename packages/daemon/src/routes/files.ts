/**
 * File Routes - File system operations endpoints
 *
 * Provides REST API for reading files, listing directories, and getting file trees.
 */

import { Router } from "@oak/oak";
import { SessionManager } from "../lib/session-manager.ts";
import { FileManager } from "../lib/file-manager.ts";

export function createFilesRouter(sessionManager: SessionManager): Router {
  const router = new Router({ prefix: "/api/sessions/:sessionId/files" });

  /**
   * GET /api/sessions/:sessionId/files - Read file content
   */
  router.get("/", async (ctx) => {
    const sessionId = ctx.params.sessionId!;
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      ctx.response.status = 404;
      ctx.response.body = { error: `Session ${sessionId} not found` };
      return;
    }

    const path = ctx.request.url.searchParams.get("path");
    if (!path) {
      ctx.response.status = 400;
      ctx.response.body = { error: "path query parameter is required" };
      return;
    }

    const encoding = (ctx.request.url.searchParams.get("encoding") ||
      "utf-8") as "utf-8" | "base64";

    try {
      const fileManager = new FileManager(session.getSessionData().workspacePath);
      const fileData = await fileManager.readFile(path, encoding);

      ctx.response.status = 200;
      ctx.response.body = fileData;
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = {
        error: error instanceof Error ? error.message : "Failed to read file",
      };
    }
  });

  /**
   * GET /api/sessions/:sessionId/files/list - List directory contents
   */
  router.get("/list", async (ctx) => {
    const sessionId = ctx.params.sessionId!;
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      ctx.response.status = 404;
      ctx.response.body = { error: `Session ${sessionId} not found` };
      return;
    }

    const path = ctx.request.url.searchParams.get("path") || ".";
    const recursive = ctx.request.url.searchParams.get("recursive") === "true";

    try {
      const fileManager = new FileManager(session.getSessionData().workspacePath);
      const files = await fileManager.listDirectory(path, recursive);

      ctx.response.status = 200;
      ctx.response.body = { files };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = {
        error: error instanceof Error ? error.message : "Failed to list directory",
      };
    }
  });

  /**
   * GET /api/sessions/:sessionId/files/tree - Get file tree
   */
  router.get("/tree", async (ctx) => {
    const sessionId = ctx.params.sessionId!;
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      ctx.response.status = 404;
      ctx.response.body = { error: `Session ${sessionId} not found` };
      return;
    }

    const path = ctx.request.url.searchParams.get("path") || ".";
    const maxDepth = parseInt(
      ctx.request.url.searchParams.get("maxDepth") || "3",
    );

    try {
      const fileManager = new FileManager(session.getSessionData().workspacePath);
      const tree = await fileManager.getFileTree(path, maxDepth);

      ctx.response.status = 200;
      ctx.response.body = { tree };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = {
        error: error instanceof Error ? error.message : "Failed to get file tree",
      };
    }
  });

  return router;
}
