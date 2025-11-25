/**
 * Message RPC Handlers
 */

import type { MessageHub } from "@liuboer/shared";
import type { SessionManager } from "../session-manager";

export function setupMessageHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
): void {
  messageHub.handle("message.list", async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = sessionManager.getSession(targetSessionId);

    if (!agentSession) {
      throw new Error("Session not found");
    }

    const messages = agentSession.getMessages();
    return { messages };
  });

  messageHub.handle("message.sdkMessages", async (data) => {
    const { sessionId: targetSessionId, limit, offset, since } = data as {
      sessionId: string;
      limit?: number;
      offset?: number;
      since?: number;
    };

    const agentSession = sessionManager.getSession(targetSessionId);

    if (!agentSession) {
      throw new Error("Session not found");
    }

    const sdkMessages = agentSession.getSDKMessages(limit, offset, since);
    return { sdkMessages };
  });
}
