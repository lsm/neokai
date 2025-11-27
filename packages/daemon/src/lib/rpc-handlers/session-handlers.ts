/**
 * Session RPC Handlers
 */

import type { MessageHub } from "@liuboer/shared";
import type { SessionManager } from "../session-manager";
import type {
  CreateSessionRequest,
  UpdateSessionRequest,
} from "@liuboer/shared";

export function setupSessionHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
): void {
  messageHub.handle("session.create", async (data) => {
    const req = data as CreateSessionRequest;
    const sessionId = await sessionManager.createSession({
      workspacePath: req.workspacePath,
      initialTools: req.initialTools,
      config: req.config,
    });
    return { sessionId };
  });

  messageHub.handle("session.list", async () => {
    const sessions = sessionManager.listSessions();
    return { sessions };
  });

  messageHub.handle("session.get", async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = sessionManager.getSession(targetSessionId);

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

  messageHub.handle("session.update", async (data, ctx) => {
    const { sessionId: targetSessionId, ...updates } = data as
      & UpdateSessionRequest
      & { sessionId: string };

    await sessionManager.updateSession(targetSessionId, updates);

    // Broadcast update event to all clients
    await messageHub.publish("session.updated", updates, {
      sessionId: targetSessionId,
    });

    return { success: true };
  });

  messageHub.handle("session.delete", async (data, ctx) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    await sessionManager.deleteSession(targetSessionId);

    // Broadcast deletion event to all clients
    await messageHub.publish("session.deleted", {}, {
      sessionId: targetSessionId,
    });

    return { success: true };
  });

  // Handle message sending to a session
  messageHub.handle("message.send", async (data) => {
    const { sessionId: targetSessionId, content, images } = data as {
      sessionId: string;
      content: string;
      images?: Array<{ data: string; media_type: string }>;
    };

    const agentSession = sessionManager.getSession(targetSessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    return await agentSession.handleMessageSend({ content, images });
  });

  // Handle session interruption
  messageHub.handle("client.interrupt", async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = sessionManager.getSession(targetSessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    await agentSession.handleInterrupt();
    return { success: true };
  });
}
