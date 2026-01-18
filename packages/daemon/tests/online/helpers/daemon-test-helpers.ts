/**
 * Helper utilities for online daemon tests
 *
 * These helpers provide convenient patterns for:
 * - Sending messages via RPC
 * - Waiting for state changes via subscriptions
 * - Observing agent behavior through events
 */

import type { DaemonServerContext } from "./daemon-server-helper";

/**
 * Send a message via RPC and return the messageId
 */
export async function sendMessage(
  daemon: DaemonServerContext,
  sessionId: string,
  content: string,
  options: {
    images?: Array<{ type: string; source: { type: string; data: string } }>;
  } = {},
): Promise<{ messageId: string }> {
  const result = (await daemon.messageHub.call("message.send", {
    sessionId,
    content,
    ...options,
  })) as { messageId: string };
  return result;
}

/**
 * Wait for the agent to reach a specific processing state
 *
 * Uses state.session subscription to monitor agent state changes.
 *
 * NOTE: The state structure uses 'agentState' (not 'processingState').
 * See SessionState interface in @liuboer/shared/src/state-types.ts
 */
export async function waitForProcessingState(
  daemon: DaemonServerContext,
  sessionId: string,
  targetStatus: string,
  timeout = 30000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    // Set up timeout
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(
        new Error(
          `Timeout waiting for processing state "${targetStatus}" after ${timeout}ms`,
        ),
      );
    }, timeout);

    // Subscribe to state changes - returns unsubscribe function
    daemon.messageHub
      .subscribe(
        "state.session",
        (data: unknown) => {
          const state = data as { agentState?: { status: string } };
          const currentStatus = state.agentState?.status;

          if (currentStatus === targetStatus) {
            clearTimeout(timer);
            unsubscribe?.();
            resolve();
          }
        },
        { sessionId },
      )
      .then((fn) => {
        unsubscribe = fn;
      });
  });
}

/**
 * Wait for the agent to reach idle state
 */
export async function waitForIdle(
  daemon: DaemonServerContext,
  sessionId: string,
  timeout = 30000,
): Promise<void> {
  return waitForProcessingState(daemon, sessionId, "idle", timeout);
}

/**
 * Wait for the agent to start processing
 */
export async function waitForProcessing(
  daemon: DaemonServerContext,
  sessionId: string,
  timeout = 10000,
): Promise<void> {
  return waitForProcessingState(daemon, sessionId, "processing", timeout);
}

/**
 * Collect SDK messages from the session via subscription
 *
 * Returns an async generator that yields SDK messages as they arrive.
 */
export async function* collectSDKMessages(
  daemon: DaemonServerContext,
  sessionId: string,
  timeout = 30000,
): AsyncGenerator<unknown, void, unknown> {
  const messages: unknown[] = [];
  let resolved = false;
  let unsubscribe: (() => void) | null = null;

  const timer = setTimeout(() => {
    if (!resolved && unsubscribe) {
      resolved = true;
      unsubscribe();
    }
  }, timeout);

  unsubscribe = await daemon.messageHub.subscribe(
    "state.sdkMessages.delta",
    (data: unknown) => {
      if (resolved) return;
      messages.push(data);
    },
    { sessionId },
  );

  try {
    while (!resolved) {
      // Check if we have messages to yield
      while (messages.length > 0) {
        yield messages.shift();
      }
      // Small delay to prevent busy-waiting
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    clearTimeout(timer);
    if (unsubscribe) {
      unsubscribe();
    }
  }
}

/**
 * Wait for a specific SDK message type
 */
export async function waitForSDKMessage(
  daemon: DaemonServerContext,
  sessionId: string,
  messageType: string,
  timeout = 30000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(
        new Error(
          `Timeout waiting for SDK message type "${messageType}" after ${timeout}ms`,
        ),
      );
    }, timeout);

    daemon.messageHub
      .subscribe(
        "sdk.message",
        (data: unknown) => {
          const msg = data as { type?: string };
          if (msg.type === messageType) {
            clearTimeout(timer);
            unsubscribe?.();
            resolve(data);
          }
        },
        { sessionId },
      )
      .then((fn) => {
        unsubscribe = fn;
      });
  });
}

/**
 * Get current processing state via RPC
 */
export async function getProcessingState(
  daemon: DaemonServerContext,
  sessionId: string,
): Promise<{ status: string; phase?: string }> {
  const result = (await daemon.messageHub.call("agent.getState", {
    sessionId,
  })) as { state: { status: string; phase?: string } } | undefined;

  if (!result?.state) {
    // Return a default state if RPC fails or returns unexpected data
    return { status: "unknown" };
  }

  return result.state;
}

/**
 * Get session data via RPC
 */
export async function getSession(
  daemon: DaemonServerContext,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const result = (await daemon.messageHub.call("session.get", {
    sessionId,
  })) as { session: Record<string, unknown> } | undefined;

  if (!result?.session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return result.session;
}

/**
 * Get current model via RPC
 */
export async function getCurrentModel(
  daemon: DaemonServerContext,
  sessionId: string,
): Promise<{ id: string; displayName: string }> {
  const result = (await daemon.messageHub.call("session.model.get", {
    sessionId,
  })) as
    | { currentModel: string; modelInfo: { id: string; displayName: string } }
    | undefined;

  if (!result?.modelInfo) {
    throw new Error(`Failed to get model for session: ${sessionId}`);
  }

  return result.modelInfo;
}

/**
 * Switch model via RPC
 */
export async function switchModel(
  daemon: DaemonServerContext,
  sessionId: string,
  model: string,
): Promise<{ success: boolean; model: string; error?: string }> {
  const result = (await daemon.messageHub.call("session.model.switch", {
    sessionId,
    model,
  })) as { success: boolean; model: string; error?: string } | undefined;

  if (!result) {
    throw new Error(`Failed to switch model for session: ${sessionId}`);
  }

  return result;
}

/**
 * List all sessions via RPC
 */
export async function listSessions(
  daemon: DaemonServerContext,
): Promise<Array<Record<string, unknown>>> {
  const result = (await daemon.messageHub.call("session.list", {})) as
    | {
        sessions: Array<Record<string, unknown>>;
      }
    | undefined;

  if (!result?.sessions) {
    return [];
  }

  return result.sessions;
}

/**
 * Delete a session via RPC
 */
export async function deleteSession(
  daemon: DaemonServerContext,
  sessionId: string,
): Promise<void> {
  await daemon.messageHub.call("session.delete", { sessionId });
}

/**
 * Interrupt the current processing via RPC
 */
export async function interrupt(
  daemon: DaemonServerContext,
  sessionId: string,
): Promise<void> {
  await daemon.messageHub.call("client.interrupt", { sessionId });
}
