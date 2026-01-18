/**
 * MCP Toggle - Session Config Sync Tests
 *
 * Tests for verifying that MCP toggle state is correctly synced to session config.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from "../fixtures";
import {
  cleanupSettingsLocalJson,
  ensureClaudeDir,
  openToolsModal,
  saveToolsModal,
  getMcpServerNames,
  isMcpServerEnabled,
  toggleMcpServer,
  enableAllMcpServers,
  disableAllMcpServers,
  getMcpConfigViaRPC,
} from "./helpers/mcp-toggle-helpers";
import {
  waitForSessionCreated,
  waitForWebSocketConnected,
  cleanupTestSession,
} from "./helpers/wait-helpers";

test.describe("MCP Toggle - Session Config Sync", () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    cleanupSettingsLocalJson();
    ensureClaudeDir();

    await page.goto("/");
    await waitForWebSocketConnected(page);

    const newSessionButton = page.getByRole("button", {
      name: "New Session",
      exact: true,
    });
    await newSessionButton.click();
    sessionId = await waitForSessionCreated(page);
  });

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      try {
        await cleanupTestSession(page, sessionId);
      } catch (error) {
        console.warn(`Failed to cleanup session ${sessionId}:`, error);
      }
      sessionId = null;
    }
    cleanupSettingsLocalJson();
  });

  test("should sync disabledMcpServers to session config", async ({ page }) => {
    if (!sessionId) {
      throw new Error("Session ID is required for this test");
    }

    await openToolsModal(page);

    const serverNames = await getMcpServerNames(page);
    if (serverNames.length === 0) {
      console.log("Skipping test - no MCP servers available");
      return;
    }

    // Disable first server
    const wasEnabled = await isMcpServerEnabled(page, serverNames[0]);
    if (wasEnabled) {
      await toggleMcpServer(page, serverNames[0]);
    }
    await saveToolsModal(page);

    // Verify session config via RPC
    const mcpConfig = await getMcpConfigViaRPC(page, sessionId);
    expect(mcpConfig.disabledMcpServers).toContain(serverNames[0]);
  });

  test("should clear disabledMcpServers when all servers enabled", async ({
    page,
  }) => {
    if (!sessionId) {
      throw new Error("Session ID is required for this test");
    }

    await openToolsModal(page);

    const serverNames = await getMcpServerNames(page);
    if (serverNames.length === 0) {
      console.log("Skipping test - no MCP servers available");
      return;
    }

    // First disable all
    await disableAllMcpServers(page);
    await saveToolsModal(page);

    // Verify all disabled in config
    let mcpConfig = await getMcpConfigViaRPC(page, sessionId);
    expect(mcpConfig.disabledMcpServers?.length).toBe(serverNames.length);

    // Enable all
    await openToolsModal(page);
    await enableAllMcpServers(page);
    await saveToolsModal(page);

    // Verify config is cleared
    mcpConfig = await getMcpConfigViaRPC(page, sessionId);
    expect(mcpConfig.disabledMcpServers?.length).toBe(0);
  });
});
