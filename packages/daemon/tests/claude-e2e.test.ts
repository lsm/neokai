/**
 * Claude End-to-End Integration Test
 *
 * Tests the complete flow:
 * 1. Create a session
 * 2. Connect to WebSocket
 * 3. Send a message via HTTP API
 * 4. Receive streaming response from Claude via WebSocket
 * 5. Verify the response content
 *
 * This test validates the full integration between the daemon API,
 * WebSocket event streaming, and Claude Agent SDK.
 */

import { describe, test, expect } from "bun:test";
import type { CreateSessionResponse, SendMessageResponse } from "@liuboer/shared";
import {
  createTestApp,
  request,
  assertSuccessResponse,
  createWebSocketWithFirstMessage,
  hasAnyCredentials,
} from "./test-utils";

describe("Claude End-to-End Integration", () => {
  test.skipIf(!hasAnyCredentials())(
    "should send a message and receive Claude response via WebSocket",
    async () => {
      const ctx = await createTestApp();
      try {
        console.log("\n[E2E TEST] Starting Claude end-to-end test");

        // Step 1: Create session
        console.log("[E2E TEST] Step 1: Creating session...");
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );
        console.log(`[E2E TEST] Session created: ${sessionId}`);

        // Step 2: Connect WebSocket and consume initial connection message
        console.log("[E2E TEST] Step 2: Connecting WebSocket...");
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
          ctx.baseUrl,
          sessionId,
        );
        const connectionMsg = await firstMessagePromise;
        expect(connectionMsg.type).toBe("connection.established");
        console.log("[E2E TEST] WebSocket connected");

        // Step 3: Collect WebSocket messages
        const messages: any[] = [];
        let messageComplete = false;

        const messagePromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (!messageComplete) {
              reject(new Error("Timeout waiting for message.complete event"));
            }
          }, 30000); // 30 second timeout

          ws.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data as string);
              console.log(`[E2E TEST] Received event: ${data.type}`);
              messages.push(data);

              if (data.type === "message.complete") {
                messageComplete = true;
                clearTimeout(timeout);
                resolve();
              } else if (data.type === "error") {
                clearTimeout(timeout);
                reject(new Error(`Error event received: ${JSON.stringify(data)}`));
              }
            } catch (error) {
              console.error("[E2E TEST] Error parsing message:", error);
            }
          };

          ws.onerror = (error) => {
            clearTimeout(timeout);
            reject(error);
          };
        });

        // Step 4: Send a simple message via HTTP API
        console.log("[E2E TEST] Step 3: Sending message via HTTP API...");
        const messageContent = "What is 2+2? Answer with just the number.";
        const sendRes = await request(
          ctx.baseUrl,
          "POST",
          `/api/sessions/${sessionId}/messages`,
          { content: messageContent },
        );
        const sendResponse = await assertSuccessResponse<SendMessageResponse>(
          sendRes,
          201,
        );
        expect(sendResponse.messageId).toBeDefined();
        expect(sendResponse.status).toBe("processing");
        console.log(`[E2E TEST] Message sent, ID: ${sendResponse.messageId}`);

        // Step 5: Wait for message to be processed
        console.log("[E2E TEST] Step 4: Waiting for Claude response...");
        await messagePromise;
        console.log(`[E2E TEST] Received ${messages.length} events`);

        // Step 6: Verify events received
        console.log("[E2E TEST] Step 5: Verifying events...");

        // Should have received message.start event
        const messageStartEvents = messages.filter((m) => m.type === "message.start");
        expect(messageStartEvents.length).toBeGreaterThan(0);
        console.log(`[E2E TEST] ✓ Received ${messageStartEvents.length} message.start event(s)`);

        // Should have received message.content events (streaming)
        const contentEvents = messages.filter((m) => m.type === "message.content");
        expect(contentEvents.length).toBeGreaterThan(0);
        console.log(`[E2E TEST] ✓ Received ${contentEvents.length} message.content event(s)`);

        // Should have received message.complete event
        const completeEvents = messages.filter((m) => m.type === "message.complete");
        expect(completeEvents.length).toBe(1);
        console.log("[E2E TEST] ✓ Received message.complete event");

        // Should have received context.updated event (with usage stats)
        const contextEvents = messages.filter((m) => m.type === "context.updated");
        expect(contextEvents.length).toBeGreaterThan(0);
        console.log(`[E2E TEST] ✓ Received ${contextEvents.length} context.updated event(s)`);

        // Step 7: Verify assistant response content
        console.log("[E2E TEST] Step 6: Verifying response content...");
        const fullResponse = contentEvents
          .map((e) => e.data?.delta || "")
          .join("");

        console.log(`[E2E TEST] Full assistant response: "${fullResponse}"`);
        expect(fullResponse.length).toBeGreaterThan(0);
        expect(fullResponse.toLowerCase()).toContain("4"); // Should contain the answer "4"
        console.log("[E2E TEST] ✓ Response contains expected answer");

        // Step 8: Verify message.complete has the full message
        const completeEvent = completeEvents[0];
        expect(completeEvent.data?.message).toBeDefined();
        expect(completeEvent.data.message.role).toBe("assistant");
        expect(completeEvent.data.message.content.length).toBeGreaterThan(0);
        console.log("[E2E TEST] ✓ message.complete contains full message");

        // Step 9: Verify context.updated has usage stats
        const contextEvent = contextEvents[0];
        expect(contextEvent.data?.tokenUsage).toBeDefined();
        expect(contextEvent.data.tokenUsage.inputTokens).toBeGreaterThan(0);
        expect(contextEvent.data.tokenUsage.outputTokens).toBeGreaterThan(0);
        console.log("[E2E TEST] ✓ context.updated contains usage stats");
        console.log(`[E2E TEST]   Input tokens: ${contextEvent.data.tokenUsage.inputTokens}`);
        console.log(`[E2E TEST]   Output tokens: ${contextEvent.data.tokenUsage.outputTokens}`);
        if (contextEvent.data.costUSD) {
          console.log(`[E2E TEST]   Cost: $${contextEvent.data.costUSD.toFixed(6)}`);
        }

        // Step 10: Verify we can retrieve the messages via HTTP API
        console.log("[E2E TEST] Step 7: Verifying messages via HTTP API...");
        const messagesRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/messages`,
        );
        const { messages: storedMessages } = await assertSuccessResponse<{
          messages: any[];
        }>(messagesRes, 200);

        expect(storedMessages.length).toBe(2); // user + assistant
        expect(storedMessages[0].role).toBe("user");
        expect(storedMessages[0].content).toBe(messageContent);
        expect(storedMessages[1].role).toBe("assistant");
        expect(storedMessages[1].content.length).toBeGreaterThan(0);
        console.log("[E2E TEST] ✓ Messages stored correctly in database");

        console.log("\n[E2E TEST] ✅ All checks passed!");

        ws.close();
      } catch (error) {
        console.error("\n[E2E TEST] ❌ Test failed:", error);
        throw error;
      } finally {
        await ctx.cleanup();
      }
    },
    35000, // 35 second timeout for the full test
  );

  test.skipIf(!hasAnyCredentials())(
    "should handle multiple messages in the same session",
    async () => {
      const ctx = await createTestApp();
      try {
        console.log("\n[E2E TEST] Starting multi-message test");

        // Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Connect WebSocket
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
          ctx.baseUrl,
          sessionId,
        );
        await firstMessagePromise;

        // Helper to send a message and wait for completion
        const sendAndWait = async (content: string): Promise<string> => {
          return new Promise(async (resolve, reject) => {
            let fullResponse = "";
            let messageComplete = false;

            const timeout = setTimeout(() => {
              if (!messageComplete) {
                reject(new Error("Timeout waiting for response"));
              }
            }, 30000);

            const messageHandler = (event: MessageEvent) => {
              try {
                const data = JSON.parse(event.data as string);
                if (data.type === "message.content") {
                  fullResponse += data.data?.delta || "";
                } else if (data.type === "message.complete") {
                  messageComplete = true;
                  clearTimeout(timeout);
                  ws.removeEventListener("message", messageHandler);
                  resolve(fullResponse);
                } else if (data.type === "error") {
                  clearTimeout(timeout);
                  ws.removeEventListener("message", messageHandler);
                  reject(new Error(`Error: ${JSON.stringify(data)}`));
                }
              } catch (error) {
                // Ignore parse errors
              }
            };

            ws.addEventListener("message", messageHandler);

            // Send message
            await request(
              ctx.baseUrl,
              "POST",
              `/api/sessions/${sessionId}/messages`,
              { content },
            );
          });
        };

        // Send first message
        console.log("[E2E TEST] Sending first message...");
        const response1 = await sendAndWait("What is 5+3? Just the number.");
        console.log(`[E2E TEST] First response: "${response1}"`);
        expect(response1.toLowerCase()).toContain("8");

        // Send second message (tests conversation history)
        console.log("[E2E TEST] Sending second message...");
        const response2 = await sendAndWait("What is 10-2? Just the number.");
        console.log(`[E2E TEST] Second response: "${response2}"`);
        expect(response2.toLowerCase()).toContain("8");

        // Verify all messages are stored
        const messagesRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/messages`,
        );
        const { messages } = await assertSuccessResponse<{ messages: any[] }>(
          messagesRes,
          200,
        );

        expect(messages.length).toBe(4); // 2 user + 2 assistant
        console.log("[E2E TEST] ✓ All messages stored correctly");

        console.log("\n[E2E TEST] ✅ Multi-message test passed!");

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    },
    60000, // 60 second timeout for multiple messages
  );
});
