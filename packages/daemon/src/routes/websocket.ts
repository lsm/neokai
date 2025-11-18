/**
 * WebSocket Routes - Real-time event streaming
 *
 * Provides WebSocket endpoint for clients to receive real-time updates.
 */

import { RouterContext } from "@oak/oak";
import { EventBus } from "../lib/event-bus.ts";
import { SessionManager } from "../lib/session-manager.ts";

export function setupWebSocket(
  eventBus: EventBus,
  sessionManager: SessionManager,
) {
  return async (ctx: RouterContext<"/ws/:sessionId">) => {
    if (!ctx.isUpgradable) {
      ctx.response.status = 400;
      ctx.response.body = { error: "WebSocket upgrade required" };
      return;
    }

    // Get session ID from URL params
    const sessionId = ctx.params.sessionId;
    if (!sessionId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Session ID required" };
      return;
    }

    // Verify session exists
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      ctx.response.status = 404;
      ctx.response.body = { error: `Session ${sessionId} not found` };
      return;
    }

    // Upgrade connection to WebSocket
    const ws = await ctx.upgrade();
    console.log(`WebSocket connected for session: ${sessionId}`);

    // Subscribe to events
    eventBus.subscribeWebSocket(sessionId, ws);

    // Send initial connection message (only if WebSocket is OPEN)
    if (ws.readyState === WebSocket.OPEN) {
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
    } else {
      console.warn(
        `WebSocket for session ${sessionId} not in OPEN state (readyState: ${ws.readyState})`,
      );
    }

    // Handle incoming messages
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "ping") {
          // Respond to ping with pong
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "pong",
                timestamp: new Date().toISOString(),
              }),
            );
          }
        } else if (data.type === "subscribe") {
          // Handle subscription requests (for future filtering)
          console.log(
            `Client subscribed to events: ${data.events?.join(", ") || "all"}`,
          );
        }
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
        if (ws.readyState === WebSocket.OPEN) {
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
      }
    };

    // Handle connection close
    ws.onclose = () => {
      console.log(`WebSocket disconnected for session: ${sessionId}`);
      eventBus.unsubscribeWebSocket(sessionId, ws);
    };

    // Handle errors
    ws.onerror = (error) => {
      console.error(`WebSocket error for session ${sessionId}:`, error);
      eventBus.unsubscribeWebSocket(sessionId, ws);
    };
  };
}
