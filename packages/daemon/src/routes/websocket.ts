/**
 * WebSocket Routes - Real-time event streaming
 *
 * Provides WebSocket endpoint for clients to receive real-time updates.
 */

import type { Elysia } from "elysia";
import type { EventBus } from "../lib/event-bus";
import type { SessionManager } from "../lib/session-manager";

export function setupWebSocket(
  app: Elysia,
  eventBus: EventBus,
  sessionManager: SessionManager,
) {
  return app.ws("/ws/:sessionId", {
    open(ws) {
      const sessionId = ws.data.params.sessionId;
      console.log(`WebSocket connected for session: ${sessionId}`);

      // Verify session exists
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        console.error(`Session ${sessionId} not found during WebSocket open`);
        ws.close();
        return;
      }

      // Subscribe to events
      eventBus.subscribeWebSocket(sessionId, ws.raw);

      // Send initial connection message
      try {
        ws.send(
          JSON.stringify({
            type: "connection.established",
            sessionId,
            timestamp: new Date().toISOString(),
            data: {
              message: "WebSocket connection established",
              sessionId,
            },
          }),
        );
      } catch (error) {
        console.error(
          `Error sending initial WebSocket message for session ${sessionId}:`,
          error,
        );
      }
    },

    message(ws, message) {
      const sessionId = ws.data.params.sessionId;

      try {
        const data = typeof message === "string" ? JSON.parse(message) : message;

        if (data.type === "ping") {
          // Respond to ping with pong
          ws.send(
            JSON.stringify({
              type: "pong",
              timestamp: new Date().toISOString(),
            }),
          );
        } else if (data.type === "subscribe") {
          // Handle subscription requests (for future filtering)
          console.log(
            `Client subscribed to events: ${data.events?.join(", ") || "all"}`,
          );
        }
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
        ws.send(
          JSON.stringify({
            type: "error",
            sessionId,
            timestamp: new Date().toISOString(),
            data: {
              error: "Invalid message format",
            },
          }),
        );
      }
    },

    close(ws) {
      const sessionId = ws.data.params.sessionId;
      console.log(`WebSocket disconnected for session: ${sessionId}`);
      eventBus.unsubscribeWebSocket(sessionId, ws.raw);
    },

    error(ws, error) {
      const sessionId = ws.data.params.sessionId;
      console.error(`WebSocket error for session ${sessionId}:`, error);
      eventBus.unsubscribeWebSocket(sessionId, ws.raw);
    },
  });
}
