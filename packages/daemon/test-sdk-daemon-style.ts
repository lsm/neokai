/**
 * Test script to reproduce the SDK issue as the daemon calls it
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import "dotenv/config";

async function testQuery() {
  console.log("[TEST] Starting SDK query test...");
  console.log("[TEST] CLAUDE_CODE_OAUTH_TOKEN:", process.env.CLAUDE_CODE_OAUTH_TOKEN ? "SET" : "NOT SET");
  console.log("[TEST] ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "SET" : "NOT SET");
  console.log("[TEST] Current working directory:", process.cwd());

  try {
    const queryStream = query({
      prompt: "What is 2+2? Answer with just the number.",
      options: {
        model: "claude-sonnet-4-5",
        cwd: process.cwd(),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
      },
    });

    console.log("[TEST] Query stream created, processing...");

    for await (const message of queryStream) {
      console.log("[TEST] Message type:", message.type);
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            console.log("[TEST] Response:", block.text);
          }
        }
      }
    }

    console.log("[TEST] Success!");
  } catch (error) {
    console.error("[TEST] Error:", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

testQuery();
