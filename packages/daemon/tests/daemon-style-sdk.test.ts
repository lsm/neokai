/**
 * Test to replicate daemon's exact SDK usage
 * This helps us debug why the daemon hangs but tests pass
 */

import { describe, test, expect } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import "dotenv/config";
import { hasAnyCredentials } from "./test-utils";

describe("Daemon-style SDK Usage", () => {
  test.skipIf(!hasAnyCredentials())(
    "should work with cwd option (like daemon does)",
    async () => {
      console.log("\n[TEST] Testing with cwd option...");
      console.log("[TEST] Current working directory:", process.cwd());

      const queryStream = query({
        prompt: "What is 2+2? Answer with just the number.",
        options: {
          model: "claude-sonnet-4-5-20250929",
          cwd: process.cwd(), // DAEMON SETS THIS
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
        },
      });

      console.log("[TEST] Query stream created, processing...");
      let assistantResponse = "";
      let messageCount = 0;

      for await (const message of queryStream) {
        messageCount++;
        console.log(`[TEST] Received message #${messageCount}, type: ${message.type}`);

        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") {
              assistantResponse += block.text;
              console.log("[TEST] Response:", block.text);
            }
          }
        }
      }

      console.log("[TEST] Final response:", assistantResponse);
      console.log("[TEST] Total messages:", messageCount);

      expect(assistantResponse.length).toBeGreaterThan(0);
      expect(messageCount).toBeGreaterThan(0);
      console.log("[TEST] Success!");
    },
    60000, // 60 second timeout
  );

  test.skipIf(!hasAnyCredentials())(
    "should work WITHOUT cwd option (like original test)",
    async () => {
      console.log("\n[TEST] Testing WITHOUT cwd option...");

      const queryStream = query({
        prompt: "What is 2+2? Answer with just the number.",
        options: {
          model: "claude-sonnet-4-5-20250929",
          // NO cwd option
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
        },
      });

      console.log("[TEST] Query stream created, processing...");
      let assistantResponse = "";
      let messageCount = 0;

      for await (const message of queryStream) {
        messageCount++;
        console.log(`[TEST] Received message #${messageCount}, type: ${message.type}`);

        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") {
              assistantResponse += block.text;
            }
          }
        }
      }

      console.log("[TEST] Final response:", assistantResponse);
      console.log("[TEST] Total messages:", messageCount);

      expect(assistantResponse.length).toBeGreaterThan(0);
      expect(messageCount).toBeGreaterThan(0);
      console.log("[TEST] Success!");
    },
    60000,
  );
});
