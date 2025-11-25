/**
 * MessageHub WebSocket Routes using Bun Native WebSocket
 *
 * UNIFIED WebSocket endpoint - all messages routed by sessionId field
 * Following MessageHub architectural principle: "sessionId in message, not URL"
 */

import type { Elysia } from "elysia";
import { createEventMessage, createErrorMessage, MessageType, generateUUID } from "@liuboer/shared";
import type { WebSocketServerTransport } from "../lib/websocket-server-transport";
import type { SessionManager } from "../lib/session-manager";
import type { SubscriptionManager } from "../lib/subscription-manager";

const GLOBAL_SESSION_ID = "global";

export function setupMessageHubWebSocket(
  app: Elysia<any>,
  transport: WebSocketServerTransport,
  sessionManager: SessionManager,
  subscriptionManager: SubscriptionManager,
) {
  // UNIFIED WebSocket endpoint - single connection handles all sessions
  // Session routing is done via message.sessionId field, not URL
  return app.ws("/ws", {
    open(ws) {
      console.log("WebSocket connection established");

      // Register client with transport (starts in global session)
      const clientId = transport.registerClient(ws.raw, GLOBAL_SESSION_ID);

      // Store clientId on websocket for cleanup and message handling
      (ws.raw as any).__clientId = clientId;

      // Subscribe client to global events
      // This is APPLICATION logic - SubscriptionManager defines what events to subscribe to
      subscriptionManager.subscribeToGlobalEvents(clientId).catch((error) => {
        console.error(`Failed to subscribe client ${clientId} to global events:`, error);
      });

      // Send connection confirmation as a proper EVENT message
      const connectionEvent = createEventMessage({
        method: "connection.established",
        sessionId: GLOBAL_SESSION_ID,
        data: {
          message: "WebSocket connection established",
          protocol: "MessageHub",
          version: "1.0.0",
        },
      });
      ws.send(JSON.stringify(connectionEvent));
    },

    message(ws, message) {
      try {
        const data = typeof message === "string" ? JSON.parse(message) : message;

        // Handle ping/pong
        if (data.type === "ping" || data.type === "PING") {
          const pongMsg = {
            id: generateUUID(),
            type: MessageType.PONG,
            sessionId: data.sessionId || GLOBAL_SESSION_ID,
            method: "heartbeat",
            timestamp: new Date().toISOString(),
            requestId: data.id,
          };
          ws.send(JSON.stringify(pongMsg));
          return;
        }

        // Get client ID for subscription tracking
        const clientId = (ws.raw as any).__clientId;

        // Validate sessionId exists in message
        if (!data.sessionId) {
          console.warn("Message without sessionId, defaulting to global");
          data.sessionId = GLOBAL_SESSION_ID;
        }

        // For session-specific messages, verify session exists (except for global)
        if (data.sessionId !== GLOBAL_SESSION_ID) {
          const session = sessionManager.getSession(data.sessionId);
          if (!session) {
            const errorMsg = createErrorMessage({
              method: data.method || "unknown.method",
              error: {
                code: "SESSION_NOT_FOUND",
                message: `Session not found: ${data.sessionId}`,
              },
              sessionId: data.sessionId,
              requestId: data.id,
            });
            ws.send(JSON.stringify(errorMsg));
            return;
          }
        }

        // Pass to transport which will notify MessageHub
        // Message routing is handled by sessionId field, not connection
        transport.handleClientMessage(data, clientId);
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
        const errorMsg = createErrorMessage({
          method: "message.process",
          error: {
            code: "INVALID_MESSAGE",
            message: error instanceof Error ? error.message : "Invalid message format",
          },
          sessionId: GLOBAL_SESSION_ID,
        });
        ws.send(JSON.stringify(errorMsg));
      }
    },

    close(ws) {
      console.log("WebSocket disconnected");
      const clientId = (ws.raw as any).__clientId;
      if (clientId) {
        transport.unregisterClient(clientId);
      }
    },

    error(ws, error) {
      console.error("WebSocket error:", error);
      const clientId = (ws.raw as any).__clientId;
      if (clientId) {
        transport.unregisterClient(clientId);
      }
    },
  });
}
