import type { Elysia } from "elysia";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
  SendMessageRequest,
  SendMessageResponse,
  UpdateSessionRequest,
} from "@liuboer/shared";
import type { SessionManager } from "../lib/session-manager";

export function createSessionsRouter(app: Elysia, sessionManager: SessionManager) {
  return app
    // Create session
    .post("/api/sessions", async ({ body, set }) => {
      const { workspacePath, initialTools, config } = body as CreateSessionRequest;

      const sessionId = await sessionManager.createSession({
        workspacePath,
        initialTools,
        config,
      });

      set.status = 201;
      const response: CreateSessionResponse = { sessionId };
      return response;
    })

    // List sessions
    .get("/api/sessions", () => {
      const sessions = sessionManager.listSessions();
      const response: ListSessionsResponse = { sessions };
      return response;
    })

    // Get session
    .get("/api/sessions/:sessionId", ({ params, set }) => {
      const sessionId = params.sessionId;
      const agentSession = sessionManager.getSession(sessionId);

      if (!agentSession) {
        set.status = 404;
        return { error: "Session not found" };
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

      return response;
    })

    // Update session
    .patch("/api/sessions/:sessionId", async ({ params, body, set }) => {
      const sessionId = params.sessionId;
      const updates = body as UpdateSessionRequest;

      const agentSession = sessionManager.getSession(sessionId);
      if (!agentSession) {
        set.status = 404;
        return { error: "Session not found" };
      }

      await sessionManager.updateSession(sessionId, updates);
      set.status = 204;
    })

    // Delete session
    .delete("/api/sessions/:sessionId", async ({ params, set }) => {
      const sessionId = params.sessionId;
      await sessionManager.deleteSession(sessionId);
      set.status = 204;
    })

    // Send message
    .post("/api/sessions/:sessionId/messages", async ({ params, body, set }) => {
      const sessionId = params.sessionId;
      const { content } = body as SendMessageRequest;

      const agentSession = sessionManager.getSession(sessionId);
      if (!agentSession) {
        set.status = 404;
        return { error: "Session not found" };
      }

      const messageId = await agentSession.sendMessage(content);

      set.status = 201;
      const response: SendMessageResponse = {
        messageId,
        status: "processing",
      };

      return response;
    })

    // Get messages
    .get("/api/sessions/:sessionId/messages", ({ params, set }) => {
      const sessionId = params.sessionId;
      const agentSession = sessionManager.getSession(sessionId);

      if (!agentSession) {
        set.status = 404;
        return { error: "Session not found" };
      }

      const messages = agentSession.getMessages();
      return { messages };
    });
}
