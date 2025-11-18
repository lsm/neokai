/**
 * Simple WebSocket Test - Minimal reproduction
 */

import { describe, test, expect } from "bun:test";
import { Elysia } from "elysia";

describe("Simple WebSocket Test", () => {
  test("should send and receive message", async () => {
    // Create minimal Elysia app with WebSocket
    const app = new Elysia()
      .ws("/ws", {
        open(ws) {
          console.log("Server: WebSocket opened");
          // Send message immediately
          ws.send("Hello from server");
          console.log("Server: Message sent");
        },
        message(ws, message) {
          console.log("Server: Received message:", message);
          ws.send(`Echo: ${message}`);
        },
        close(ws) {
          console.log("Server: WebSocket closed");
        },
      })
      .listen({
        hostname: "localhost",
        port: 0,
      });

    // Wait for server to start
    await Bun.sleep(100);

    const port = app.server!.port;
    console.log(`Server started on port ${port}`);

    // Create WebSocket client
    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    // Set up message listener IMMEDIATELY
    const messagePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("No message received within 2000ms"));
      }, 2000);

      ws.addEventListener("message", (event) => {
        console.log("Client: Received message:", event.data);
        clearTimeout(timeout);
        resolve(event.data);
      });

      ws.addEventListener("error", (error) => {
        console.error("Client: WebSocket error:", error);
        clearTimeout(timeout);
        reject(error);
      });

      ws.addEventListener("open", () => {
        console.log("Client: WebSocket opened");
      });
    });

    // Wait for message
    const message = await messagePromise;
    expect(message).toBe("Hello from server");

    ws.close();
    app.stop();
  });

  test("should handle message echo", async () => {
    const app = new Elysia()
      .ws("/ws", {
        message(ws, message) {
          console.log("Server echo received:", message);
          ws.send(`Echo: ${message}`);
        },
      })
      .listen({
        hostname: "localhost",
        port: 0,
      });

    await Bun.sleep(100);
    const port = app.server!.port;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    // Wait for connection
    await new Promise((resolve) => {
      ws.addEventListener("open", resolve);
    });

    console.log("Client: Connection open, sending message");

    // Set up response listener
    const responsePromise = new Promise((resolve) => {
      ws.addEventListener("message", (event) => {
        console.log("Client: Received echo:", event.data);
        resolve(event.data);
      });
    });

    // Send message
    ws.send("test");

    const response = await responsePromise;
    expect(response).toBe("Echo: test");

    ws.close();
    app.stop();
  });
});
