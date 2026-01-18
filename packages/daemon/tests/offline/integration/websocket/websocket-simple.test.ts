/**
 * Simple WebSocket Test - Minimal reproduction with native Bun
 */

import { describe, test, expect } from "bun:test";

const verbose = !!process.env.TEST_VERBOSE;
const log = verbose ? console.log : () => {};

describe("Simple WebSocket Test", () => {
  test("should send and receive message", async () => {
    // Create minimal Bun server with WebSocket
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,

      fetch(req, server) {
        if (server.upgrade(req)) {
          return; // WebSocket upgrade successful
        }
        return new Response("WebSocket upgrade failed", { status: 500 });
      },

      websocket: {
        open(ws) {
          log("Server: WebSocket opened");
          // Send message immediately
          ws.send("Hello from server");
          log("Server: Message sent");
        },
        message(ws, message) {
          log("Server: Received message:", message);
          ws.send(`Echo: ${message}`);
        },
        close(_ws) {
          log("Server: WebSocket closed");
        },
      },
    });

    // Wait for server to start
    await Bun.sleep(100);

    const port = server.port;
    log(`Server started on port ${port}`);

    // Create WebSocket client
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);

    // Set up message listener IMMEDIATELY
    const messagePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("No message received within 2000ms"));
      }, 2000);

      ws.addEventListener("message", (event) => {
        log("Client: Received message:", event.data);
        clearTimeout(timeout);
        resolve(event.data);
      });

      ws.addEventListener("error", (error) => {
        if (verbose) console.error("Client: WebSocket error:", error);
        clearTimeout(timeout);
        reject(error);
      });

      ws.addEventListener("open", () => {
        log("Client: WebSocket opened");
      });
    });

    // Wait for message
    const message = await messagePromise;
    expect(message).toBe("Hello from server");

    ws.close();
    server.stop();
  });

  test("should handle message echo", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,

      fetch(req, server) {
        if (server.upgrade(req)) {
          return;
        }
        return new Response("WebSocket upgrade failed", { status: 500 });
      },

      websocket: {
        message(ws, message) {
          log("Server echo received:", message);
          ws.send(`Echo: ${message}`);
        },
      },
    });

    await Bun.sleep(100);
    const port = server.port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);

    // Wait for connection
    await new Promise((resolve) => {
      ws.addEventListener("open", resolve);
    });

    log("Client: Connection open, sending message");

    // Set up response listener
    const responsePromise = new Promise((resolve) => {
      ws.addEventListener("message", (event) => {
        log("Client: Received echo:", event.data);
        resolve(event.data);
      });
    });

    // Send message
    ws.send("test");

    const response = await responsePromise;
    expect(response).toBe("Echo: test");

    ws.close();
    server.stop();
  });
});
