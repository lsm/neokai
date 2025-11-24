/**
 * MessageHub WebSocket Routes using Bun Native WebSocket
 *
 * WebSocket endpoints using MessageHub protocol with BunWebSocketTransport
 */

import type { Elysia } from "elysia";
import type { MessageHub } from "@liuboer/shared";
import type { BunWebSocketTransport } from "../lib/bun-websocket-transport";
import type { SessionManager } from "../lib/session-manager";

const GLOBAL_SESSION_ID = "global";

export function setupMessageHubWebSocket(
  app: Elysia<any>,
  messageHub: MessageHub,
  transport: BunWebSocketTransport,
  sessionManager: SessionManager,
) {
  // Global WebSocket for system-level operations
  app.ws("/ws", {
    open(ws) {
      console.log("Global WebSocket connection established");

      // Register client with transport
      const clientId = transport.registerClient(ws.raw, GLOBAL_SESSION_ID);

      // Store clientId on websocket for cleanup and message handling
      (ws.raw as any).__clientId = clientId;

      // Send connection confirmation
      ws.send(
        JSON.stringify({
          type: "connection.established",
          sessionId: GLOBAL_SESSION_ID,
          timestamp: new Date().toISOString(),
          data: {
            message: "Global WebSocket connection established",
            connectionType: "global",
            protocol: "MessageHub",
          },
        }),
      );
    },

    message(ws, message) {
      try {
        const data = typeof message === "string" ? JSON.parse(message) : message;

        // Handle ping/pong
        if (data.type === "ping" || data.type === "PING") {
          ws.send(
            JSON.stringify({
              type: "PONG",
              timestamp: new Date().toISOString(),
            }),
          );
          return;
        }

        // Get client ID for subscription tracking
        const clientId = (ws.raw as any).__clientId;

        // Pass to transport which will notify MessageHub
        // Also pass clientId so transport can track subscriptions
        transport.handleClientMessage(data, clientId);
      } catch (error) {
        console.error("Error processing global WebSocket message:", error);
        ws.send(
          JSON.stringify({
            type: "ERROR",
            timestamp: new Date().toISOString(),
            error: "Invalid message format",
            errorCode: "INVALID_MESSAGE",
          }),
        );
      }
    },

    close(ws) {
      console.log("Global WebSocket disconnected");
      const clientId = (ws.raw as any).__clientId;
      if (clientId) {
        transport.unregisterClient(clientId);
      }
    },

    error(ws, error) {
      console.error("Global WebSocket error:", error);
      const clientId = (ws.raw as any).__clientId;
      if (clientId) {
        transport.unregisterClient(clientId);
      }
    },
  });

  // Session-scoped WebSocket
  return app.ws("/ws/:sessionId", {
    open(ws) {
      const sessionId = ws.data.params.sessionId;

      // Reject if no session ID provided
      if (!sessionId) {
        console.error("WebSocket connection rejected: no sessionId provided");
        ws.send(
          JSON.stringify({
            type: "ERROR",
            timestamp: new Date().toISOString(),
            error: "Session ID required",
            errorCode: "MISSING_SESSION_ID",
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
            type: "ERROR",
            sessionId,
            timestamp: new Date().toISOString(),
            error: "Session not found",
            errorCode: "SESSION_NOT_FOUND",
          }),
        );
        ws.close();
        return;
      }

      // Register client with transport
      const clientId = transport.registerClient(ws.raw, sessionId);

      // Store clientId on websocket for cleanup
      (ws.raw as any).__clientId = clientId;

      // Send initial connection message
      try {
        const message = JSON.stringify({
          type: "connection.established",
          sessionId,
          timestamp: new Date().toISOString(),
          data: {
            message: "WebSocket connection established",
            sessionId,
            protocol: "MessageHub",
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

        // Handle ping/pong
        if (data.type === "ping" || data.type === "PING") {
          ws.send(
            JSON.stringify({
              type: "PONG",
              timestamp: new Date().toISOString(),
            }),
          );
          return;
        }

        // Ensure message has correct sessionId
        data.sessionId = sessionId;

        // Get client ID for subscription tracking
        const clientId = (ws.raw as any).__clientId;

        // Pass to transport which will notify MessageHub
        transport.handleClientMessage(data, clientId);
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
        ws.send(
          JSON.stringify({
            type: "ERROR",
            sessionId,
            timestamp: new Date().toISOString(),
            error: "Invalid message format",
            errorCode: "INVALID_MESSAGE",
          }),
        );
      }
    },

    close(ws) {
      const sessionId = ws.data.params.sessionId;
      if (sessionId) {
        console.log(`WebSocket disconnected for session: ${sessionId}`);
        const clientId = (ws.raw as any).__clientId;
        if (clientId) {
          transport.unregisterClient(clientId);
        }
      }
    },

    error(ws, error) {
      const sessionId = ws.data.params.sessionId;
      if (sessionId) {
        console.error(`WebSocket error for session ${sessionId}:`, error);
        const clientId = (ws.raw as any).__clientId;
        if (clientId) {
          transport.unregisterClient(clientId);
        }
      }
    },
  });
}
