import { Router } from "@oak/oak";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
  SendMessageRequest,
  SendMessageResponse,
  UpdateSessionRequest,
} from "@liuboer/shared";
import { SessionManager } from "../lib/session-manager.ts";

export function createSessionsRouter(sessionManager: SessionManager): Router {
  const router = new Router();

  // Create session
  router.post("/api/sessions", async (ctx) => {
    const body = await ctx.request.body.json() as CreateSessionRequest;

    const sessionId = await sessionManager.createSession({
      workspacePath: body.workspacePath,
      initialTools: body.initialTools,
      config: body.config,
    });

    const response: CreateSessionResponse = { sessionId };
    ctx.response.body = response;
    ctx.response.status = 201;
  });

  // List sessions
  router.get("/api/sessions", (ctx) => {
    const sessions = sessionManager.listSessions();
    const response: ListSessionsResponse = { sessions };
    ctx.response.body = response;
  });

  // Get session
  router.get("/api/sessions/:id", (ctx) => {
    const sessionId = ctx.params.id;
    const agentSession = sessionManager.getSession(sessionId);

    if (!agentSession) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Session not found" };
      return;
    }

    const session = agentSession.getSessionData();
    const messages = agentSession.getMessages();

    const response: GetSessionResponse = {
      session,
      messages,
      activeTools: [], // TODO: Implement
      context: {
        files: [],
        workingDirectory: session.workspacePath,
      },
    };

    ctx.response.body = response;
  });

  // Update session
  router.patch("/api/sessions/:id", async (ctx) => {
    const sessionId = ctx.params.id;
    const body = await ctx.request.body.json() as UpdateSessionRequest;

    const agentSession = sessionManager.getSession(sessionId);
    if (!agentSession) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Session not found" };
      return;
    }

    await sessionManager.updateSession(sessionId, body);
    ctx.response.status = 204;
  });

  // Delete session
  router.delete("/api/sessions/:id", async (ctx) => {
    const sessionId = ctx.params.id;
    await sessionManager.deleteSession(sessionId);
    ctx.response.status = 204;
  });

  // Send message
  router.post("/api/sessions/:id/messages", async (ctx) => {
    const sessionId = ctx.params.id;
    const body = await ctx.request.body.json() as SendMessageRequest;

    const agentSession = sessionManager.getSession(sessionId);
    if (!agentSession) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Session not found" };
      return;
    }

    const messageId = await agentSession.sendMessage(body.content);

    const response: SendMessageResponse = {
      messageId,
      status: "processing",
    };

    ctx.response.body = response;
    ctx.response.status = 201;
  });

  // Get messages
  router.get("/api/sessions/:id/messages", (ctx) => {
    const sessionId = ctx.params.id;
    const agentSession = sessionManager.getSession(sessionId);

    if (!agentSession) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Session not found" };
      return;
    }

    const messages = agentSession.getMessages();
    ctx.response.body = { messages };
  });

  return router;
}
