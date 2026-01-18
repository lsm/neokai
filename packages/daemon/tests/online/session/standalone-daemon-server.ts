/**
 * Standalone daemon server for SIGINT testing
 *
 * This server runs as a separate process so SIGINT can be sent
 * only to this process, not the test runner.
 */

import { createDaemonApp } from "../../../src/app";

const PORT = parseInt(process.env.PORT || "19400", 10);

async function main() {
  const { cleanup } = await createDaemonApp({
    config: {
      host: "127.0.0.1",
      port: PORT,
      defaultModel: "claude-sonnet-4.5-20250929",
      maxTokens: 8192,
      temperature: 1.0,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
      claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      dbPath: ":memory:",
      maxSessions: 10,
      nodeEnv: "test",
      workspaceRoot: `${process.env.TMPDIR || "/tmp"}/liuboer-sigint-test-${Date.now()}`,
      disableWorktrees: true,
    },
  });

  // Handle graceful shutdown on SIGINT
  process.on("SIGINT", async () => {
    console.error("[DAEMON-SERVER] Received SIGINT, cleaning up...");
    await cleanup();
    console.error("[DAEMON-SERVER] Cleanup complete, exiting...");
    process.exit(0);
  });

  // Also handle SIGTERM for cleanup
  process.on("SIGTERM", async () => {
    console.error("[DAEMON-SERVER] Received SIGTERM, cleaning up...");
    await cleanup();
    console.error("[DAEMON-SERVER] Cleanup complete, exiting...");
    process.exit(0);
  });

  console.error(`[DAEMON-SERVER] Running on port ${PORT}, PID: ${process.pid}`);
}

main().catch((error) => {
  console.error("[DAEMON-SERVER] Fatal error:", error);
  process.exit(1);
});
