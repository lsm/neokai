/**
 * Session RPC Handlers
 */

import type { MessageHub } from "@liuboer/shared";
import type { SessionManager } from "../session-manager";
import type {
  CreateSessionRequest,
  UpdateSessionRequest,
} from "@liuboer/shared";
import {
  fetchAvailableModels,
  getAllAvailableModels,
  getCachedAvailableModels,
  clearModelCache,
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

    // Return the full session object so client can optimistically update
    const agentSession = sessionManager.getSession(sessionId);
    const session = agentSession?.getSessionData();

    return { sessionId, session };
  });

  messageHub.handle("session.list", async () => {
    const sessions = sessionManager.listSessions();
    return { sessions };
  });

  messageHub.handle("session.get", async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);

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

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    return await agentSession.handleMessageSend({ content, images });
  });

  // Handle session interruption
  messageHub.handle("client.interrupt", async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    await agentSession.handleInterrupt();
    return { success: true };
  });

  // Handle getting current model information
  messageHub.handle("session.model.get", async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    const modelInfo = agentSession.getCurrentModel();
    return {
      currentModel: modelInfo.id,
      modelInfo: modelInfo.info,
    };
  });

  // Handle model switching
  messageHub.handle("session.model.switch", async (data) => {
    const { sessionId: targetSessionId, model } = data as {
      sessionId: string;
      model: string;
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    const result = await agentSession.handleModelSwitch(model);

    // If successful, broadcast the model switch event
    if (result.success) {
      await messageHub.publish(
        "session.updated",
        { model: result.model },
        { sessionId: targetSessionId }
      );
    }

    return result;
  });

  // Handle listing available models from Anthropic API
  messageHub.handle("models.list", async (data) => {
    const { useCache = true, forceRefresh = false } = data as {
      useCache?: boolean;
      forceRefresh?: boolean;
    };

    try {
      if (useCache) {
        const models = await getCachedAvailableModels({}, forceRefresh);
        return {
          models,
          cached: !forceRefresh,
        };
      } else {
        const response = await fetchAvailableModels({});
        return {
          models: response.data,
          cached: false,
          hasMore: response.has_more,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[RPC] Failed to list models:", errorMessage);
      throw new Error(`Failed to list models: ${errorMessage}`);
    }
  });

  // Handle clearing the model cache
  messageHub.handle("models.clearCache", async () => {
    clearModelCache();
    return { success: true };
  });

  // FIX: Handle getting current agent processing state
  // Called by clients after subscribing to agent.state to get initial snapshot
  messageHub.handle("agent.getState", async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error("Session not found");
    }

    const state = agentSession.getProcessingState();

    // Immediately broadcast current state to subscriber
    await messageHub.publish(
      "agent.state",
      {
        state,
        timestamp: Date.now(),
      },
      { sessionId: targetSessionId }
    );

    return { state };
  });
}
