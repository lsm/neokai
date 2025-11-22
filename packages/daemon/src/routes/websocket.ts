/**
 * WebSocket Routes - Real-time event streaming
 *
 * Provides WebSocket endpoint for clients to receive real-time updates.
 * REQUIRES valid sessionId in URL path.
 */

import type { Elysia } from "elysia";
import type { EventBusManager } from "../lib/event-bus-manager";
import type { SessionManager } from "../lib/session-manager";

export function setupWebSocket(
  app: Elysia,
  eventBusManager: EventBusManager,
  sessionManager: SessionManager,
) {
  return app.ws("/ws/:sessionId", {
    open(ws) {
      const sessionId = ws.data.params.sessionId;

      // Reject if no session ID provided
      if (!sessionId) {
        console.error("WebSocket connection rejected: no sessionId provided");
        ws.send(
          JSON.stringify({
            type: "error",
            timestamp: new Date().toISOString(),
            data: {
              error: "Session ID required",
              message: "WebSocket connection requires a valid sessionId",
            },
          }),
        );
        ws.close();
        return;
      }

      console.log(`WebSocket connection attempt for session: ${sessionId}`);

      // Verify session exists
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        console.error(`WebSocket connection rejected: session ${sessionId} not found`);
        ws.send(
          JSON.stringify({
            type: "error",
            sessionId,
            timestamp: new Date().toISOString(),
            data: {
              error: "Session not found",
              message: `Session ${sessionId} does not exist`,
            },
          }),
        );
        ws.close();
        return;
      }

      // Subscribe to events
      eventBusManager.subscribeWebSocket(sessionId, ws.raw);

      // Send initial connection message
      try {
        const message = JSON.stringify({
          type: "connection.established",
          sessionId,
          timestamp: new Date().toISOString(),
          data: {
            message: "WebSocket connection established",
            sessionId,
          },
        });
        ws.send(message);
      } catch (error) {
        console.error(
          `Error sending initial WebSocket message for session ${sessionId}:`,
          error,
        );
      }
    },

    message(ws, message) {
      const sessionId = ws.data.params.sessionId;

      // Early validation
      if (!sessionId) {
        console.error("Received message without sessionId");
        return;
      }

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
        } else if (typeof message === "string") {
          // Handle client-emitted events through EventBus
          eventBusManager.handleWebSocketMessage(sessionId, message);
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
      if (sessionId) {
        console.log(`WebSocket disconnected for session: ${sessionId}`);
        eventBusManager.unsubscribeWebSocket(sessionId, ws.raw);
      }
    },

    error(ws, error) {
      const sessionId = ws.data.params.sessionId;
      if (sessionId) {
        console.error(`WebSocket error for session ${sessionId}:`, error);
        eventBusManager.unsubscribeWebSocket(sessionId, ws.raw);
      }
    },
  });
}
