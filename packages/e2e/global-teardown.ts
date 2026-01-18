/**
 * Global Teardown - Runs after ALL tests complete
 *
 * Cleans up any orphaned sessions left behind by failed tests.
 * Uses direct database cleanup for maximum reliability.
 */

import { chromium, type FullConfig } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function globalTeardown(config: FullConfig) {
  console.log("\n🧹 Running global teardown...");

  try {
    // Launch a browser to access the app
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to the app
    const baseURL = config.projects[0].use.baseURL || "http://localhost:9283";
    await page.goto(baseURL);

    // Wait for MessageHub to connect
    await page.waitForTimeout(2000);

    // Get list of all sessions via RPC
    const sessions = await page.evaluate(async () => {
      try {
        const hub =
          (
            window as unknown as {
              __messageHub?: unknown;
              appState?: { messageHub?: unknown };
            }
          ).__messageHub ||
          (
            window as unknown as {
              __messageHub?: unknown;
              appState?: { messageHub?: unknown };
            }
          ).appState?.messageHub;
        if (!hub || !hub.call) {
          return { success: false, sessions: [] };
        }

        const result = await hub.call("session.list", {}, { timeout: 5000 });
        return { success: true, sessions: result?.sessions || [] };
      } catch (error: unknown) {
        console.error("Failed to fetch sessions:", error);
        return { success: false, sessions: [] };
      }
    });

    if (!sessions.success || sessions.sessions.length === 0) {
      console.log("✅ No sessions to clean up");
      await browser.close();
      return;
    }

    console.log(`📊 Found ${sessions.sessions.length} sessions in database`);

    // Only clean up test sessions (created in the last hour)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const testSessions = sessions.sessions.filter(
      (s: { createdAt: string; id: string }) => {
        const createdAt = new Date(s.createdAt).getTime();
        return createdAt > oneHourAgo;
      },
    );

    if (testSessions.length === 0) {
      console.log("✅ No recent test sessions to clean up");
      await browser.close();
      return;
    }

    console.log(
      `🗑️  Cleaning up ${testSessions.length} recent test sessions...`,
    );

    let cleaned = 0;
    let failed = 0;

    for (const session of testSessions) {
      const result = await page.evaluate(async (sid) => {
        try {
          const hub =
            (
              window as unknown as {
                __messageHub?: unknown;
                appState?: { messageHub?: unknown };
              }
            ).__messageHub ||
            (
              window as unknown as {
                __messageHub?: unknown;
                appState?: { messageHub?: unknown };
              }
            ).appState?.messageHub;
          if (!hub || !hub.call) {
            return { success: false };
          }

          await hub.call(
            "session.delete",
            { sessionId: sid },
            { timeout: 5000 },
          );
          return { success: true };
        } catch (error: unknown) {
          return { success: false, error: (error as Error)?.message };
        }
      }, session.id);

      if (result.success) {
        cleaned++;
      } else {
        failed++;
        console.warn(
          `  ❌ Failed to delete session ${session.id}: ${result.error}`,
        );
      }
    }

    console.log(
      `✅ Session cleanup complete: ${cleaned} cleaned, ${failed} failed\n`,
    );

    // ========================================
    // Layer 2: Git-level worktree cleanup
    // Catches any orphaned worktrees from:
    // - Failed session deletions
    // - Crashed daemon
    // - Direct DB manipulation
    // ========================================
    console.log("🧹 Layer 2: Git-level worktree cleanup...");

    try {
      const { execSync } = await import("child_process");
      const { existsSync, rmSync, readdirSync } = await import("fs");

      // Get project root (2 levels up from packages/e2e)
      const projectRoot = join(__dirname, "..", "..");
      const worktreesDir = join(projectRoot, ".worktrees");

      if (!existsSync(worktreesDir)) {
        console.log("✅ No .worktrees directory found - clean state\n");
        await browser.close();
        return;
      }

      // Count worktrees before cleanup
      const worktreeDirs = readdirSync(worktreesDir);
      console.log(`📊 Found ${worktreeDirs.length} worktree directories`);

      // Step 1: Prune git worktree metadata
      console.log("🔧 Pruning git worktree metadata...");
      try {
        const pruneOutput = execSync("git worktree prune -v", {
          cwd: projectRoot,
          encoding: "utf-8",
        });
        if (pruneOutput) {
          console.log(`   ${pruneOutput.trim()}`);
        }
      } catch (error) {
        console.warn("   ⚠️  Prune failed (continuing):", error);
      }

      // Step 2: Delete all session/* branches
      console.log("🗑️  Deleting session branches...");
      try {
        const branchesOutput = execSync('git branch --list "session/*"', {
          cwd: projectRoot,
          encoding: "utf-8",
        });

        const branches = branchesOutput
          .split("\n")
          .map((b) => b.trim())
          .filter(Boolean);

        if (branches.length > 0) {
          console.log(`   Found ${branches.length} session branches`);

          for (const branch of branches) {
            try {
              execSync(`git branch -D ${branch}`, {
                cwd: projectRoot,
                encoding: "utf-8",
              });
            } catch {
              console.warn(`   ⚠️  Failed to delete branch ${branch}`);
            }
          }

          console.log(`   ✅ Deleted ${branches.length} branches`);
        } else {
          console.log("   ✅ No session branches to delete");
        }
      } catch (error) {
        console.warn("   ⚠️  Branch cleanup failed (continuing):", error);
      }

      // Step 3: Force remove .worktrees directory
      console.log("📁 Removing .worktrees directory...");
      try {
        rmSync(worktreesDir, { recursive: true, force: true });
        console.log(
          `   ✅ Removed ${worktreeDirs.length} worktree directories`,
        );
      } catch (error) {
        console.error("   ❌ Failed to remove .worktrees directory:", error);
      }

      console.log("✅ Git cleanup complete\n");
    } catch (error) {
      console.error("❌ Git cleanup failed (non-fatal):", error);
    }

    await browser.close();
  } catch (error) {
    console.error("❌ Global teardown failed:", error);
  }
}

export default globalTeardown;
