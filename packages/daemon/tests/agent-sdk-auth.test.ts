/**
 * Claude Agent SDK Authentication Test
 *
 * Minimal test to verify that Claude Agent SDK can authenticate
 * using credentials from environment variables (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).
 */

import { describe, test, expect } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import "dotenv/config";
import { hasAnyCredentials, hasOAuthToken, hasApiKey } from "./test-utils";

describe("Claude Agent SDK Authentication", () => {
  test.skipIf(!hasAnyCredentials())("should have credentials available in environment", () => {
    const hasOAuth = hasOAuthToken();
    const hasApi = hasApiKey();
    const hasAny = hasAnyCredentials();

    console.log("Credential status:");
    console.log("  CLAUDE_CODE_OAUTH_TOKEN:", hasOAuth ? "SET" : "NOT SET");
    console.log("  ANTHROPIC_API_KEY:", hasApi ? "SET" : "NOT SET");
    console.log("  Has any credentials:", hasAny);

    expect(hasAny).toBe(true);
  });

  test.skipIf(!hasAnyCredentials())(
    "should authenticate and make a simple query with OAuth token",
    async () => {
      const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const apiKey = process.env.ANTHROPIC_API_KEY;

      console.log("\n[DEBUG] Starting authentication test");
      console.log("[DEBUG] OAuth token:", oauthToken ? `SET (${oauthToken.substring(0, 20)}...)` : "NOT SET");
      console.log("[DEBUG] API key:", apiKey ? `SET (${apiKey.substring(0, 20)}...)` : "NOT SET");

      // Test with a simple math query that should return quickly
      const prompt = "What is 2+2? Answer with just the number.";

      try {
        console.log("[DEBUG] Making query to Claude Agent SDK...");

        const queryStream = query({
          prompt,
          options: {
            model: "claude-sonnet-4-20250514",
            // Use bypass permissions for non-interactive test
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 1, // Only need one response
          },
        });

        console.log("[DEBUG] Query stream created, processing messages...");
        let assistantResponse = "";
        let messageCount = 0;

        for await (const message of queryStream) {
          messageCount++;
          console.log(`[DEBUG] Received message #${messageCount}, type: ${message.type}`);

          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "text") {
                assistantResponse += block.text;
                console.log("[DEBUG] Got text content:", block.text);
              }
            }
          } else if (message.type === "result") {
            console.log("[DEBUG] Got result with usage:", {
              input_tokens: message.usage.input_tokens,
              output_tokens: message.usage.output_tokens,
              cost_usd: message.total_cost_usd,
            });
          }
        }

        console.log("[DEBUG] Full assistant response:", assistantResponse);
        console.log("[DEBUG] Total messages received:", messageCount);

        // Verify we got a response
        expect(assistantResponse.length).toBeGreaterThan(0);
        expect(messageCount).toBeGreaterThan(0);

        console.log("[SUCCESS] Authentication test passed!");
      } catch (error) {
        console.error("[ERROR] Authentication test failed:", error);
        if (error instanceof Error) {
          console.error("[ERROR] Error message:", error.message);
          console.error("[ERROR] Error stack:", error.stack);
        }
        throw error;
      }
    },
    30000, // 30 second timeout for API call
  );

  test.skipIf(!hasAnyCredentials())(
    "should handle authentication errors gracefully",
    async () => {
      // Save original credentials
      const originalOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const originalApi = process.env.ANTHROPIC_API_KEY;

      try {
        // Set invalid credentials
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "invalid-token";
        process.env.ANTHROPIC_API_KEY = "invalid-key";

        console.log("[DEBUG] Testing with invalid credentials...");

        const queryStream = query({
          prompt: "Test",
          options: {
            model: "claude-sonnet-4-20250514",
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 1,
          },
        });

        let errorOccurred = false;
        try {
          for await (const message of queryStream) {
            console.log("[DEBUG] Received message type:", message.type);
          }
        } catch (error) {
          errorOccurred = true;
          console.log("[DEBUG] Expected error occurred:", error instanceof Error ? error.message : String(error));
        }

        // We expect an authentication error
        expect(errorOccurred).toBe(true);
        console.log("[SUCCESS] Error handling test passed!");
      } finally {
        // Restore original credentials
        if (originalOAuth) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuth;
        } else {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }

        if (originalApi) {
          process.env.ANTHROPIC_API_KEY = originalApi;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      }
    },
    30000,
  );
});
