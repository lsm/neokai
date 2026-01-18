/**
 * Integration tests for Settings RPC Handlers
 *
 * Tests the complete flow: RPC call → Handler → SettingsManager → Database → File writes
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "../../../test-utils";
import { createTestApp, callRPCHandler } from "../../../test-utils";
import type { GlobalSettings } from "@liuboer/shared";

describe("Settings RPC Integration", () => {
  let ctx: TestContext;
  let workspacePath: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    workspacePath = ctx.workspacePath;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe("settings.global.get", () => {
    test("returns default settings", async () => {
      const result = await callRPCHandler(
        ctx.messageHub,
        "settings.global.get",
        {},
      );

      expect(result).toMatchObject({
        settingSources: ["user", "project", "local"],
        disabledMcpServers: [],
      });
    });

    test("returns saved settings", async () => {
      // Pre-save settings
      ctx.settingsManager.updateGlobalSettings({
        model: "claude-opus-4-5-20251101",
        disabledMcpServers: ["test-server"],
      });

      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.global.get",
        {},
      )) as GlobalSettings;

      expect(result.model).toBe("claude-opus-4-5-20251101");
      expect(result.disabledMcpServers).toEqual(["test-server"]);
    });
  });

  describe("settings.global.update", () => {
    test("updates global settings", async () => {
      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.global.update",
        {
          updates: {
            model: "claude-haiku-3-5-20241022",
            disabledMcpServers: ["server1", "server2"],
          },
        },
      )) as { success: boolean; settings: GlobalSettings };

      expect(result.success).toBe(true);
      expect(result.settings.model).toBe("claude-haiku-3-5-20241022");
      expect(result.settings.disabledMcpServers).toEqual([
        "server1",
        "server2",
      ]);
    });

    test("persists updates to database", async () => {
      await callRPCHandler(ctx.messageHub, "settings.global.update", {
        updates: {
          model: "claude-opus-4-5-20251101",
        },
      });

      // Verify persisted to database
      const loaded = ctx.db.getGlobalSettings();
      expect(loaded.model).toBe("claude-opus-4-5-20251101");
    });

    test("performs partial update", async () => {
      // First update
      await callRPCHandler(ctx.messageHub, "settings.global.update", {
        updates: {
          model: "claude-sonnet-4-5-20250929",
          disabledMcpServers: ["server1"],
        },
      });

      // Second partial update
      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.global.update",
        {
          updates: {
            disabledMcpServers: ["server1", "server2"],
          },
        },
      )) as { success: boolean; settings: GlobalSettings };

      // Model should remain unchanged
      expect(result.settings.model).toBe("claude-sonnet-4-5-20250929");
      // disabledMcpServers should be updated
      expect(result.settings.disabledMcpServers).toEqual([
        "server1",
        "server2",
      ]);
    });
  });

  describe("settings.global.save", () => {
    test("saves complete settings", async () => {
      const completeSettings: GlobalSettings = {
        settingSources: ["project", "local"],
        model: "claude-opus-4-5-20251101",
        permissionMode: "acceptEdits",
        disabledMcpServers: ["server1"],
      };

      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.global.save",
        {
          settings: completeSettings,
        },
      )) as { success: boolean };

      expect(result.success).toBe(true);

      // Verify saved
      const loaded = ctx.db.getGlobalSettings();
      expect(loaded.settingSources).toEqual(["project", "local"]);
      expect(loaded.model).toBe("claude-opus-4-5-20251101");
      expect(loaded.permissionMode).toBe("acceptEdits");
    });
  });

  describe("settings.mcp.toggle", () => {
    test("disables MCP server", async () => {
      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.mcp.toggle",
        {
          serverName: "test-server",
          enabled: false,
        },
      )) as { success: boolean };

      expect(result.success).toBe(true);

      // Verify disabled
      const settings = ctx.settingsManager.getGlobalSettings();
      expect(settings.disabledMcpServers).toContain("test-server");
    });

    test("enables MCP server", async () => {
      // First disable
      await callRPCHandler(ctx.messageHub, "settings.mcp.toggle", {
        serverName: "test-server",
        enabled: false,
      });

      // Then enable
      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.mcp.toggle",
        {
          serverName: "test-server",
          enabled: true,
        },
      )) as { success: boolean };

      expect(result.success).toBe(true);

      // Verify enabled
      const settings = ctx.settingsManager.getGlobalSettings();
      expect(settings.disabledMcpServers).not.toContain("test-server");
    });

    test("writes to settings.local.json immediately", async () => {
      await callRPCHandler(ctx.messageHub, "settings.mcp.toggle", {
        serverName: "test-server",
        enabled: false,
      });

      const settingsPath = join(workspacePath, ".claude/settings.local.json");
      expect(existsSync(settingsPath)).toBe(true);

      const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(content.disabledMcpjsonServers).toContain("test-server");
    });
  });

  describe("settings.mcp.getDisabled", () => {
    test("returns empty array by default", async () => {
      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.mcp.getDisabled",
        {},
      )) as {
        disabledServers: string[];
      };

      expect(result.disabledServers).toEqual([]);
    });

    test("returns disabled servers", async () => {
      await callRPCHandler(ctx.messageHub, "settings.mcp.toggle", {
        serverName: "server1",
        enabled: false,
      });
      await callRPCHandler(ctx.messageHub, "settings.mcp.toggle", {
        serverName: "server2",
        enabled: false,
      });

      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.mcp.getDisabled",
        {},
      )) as {
        disabledServers: string[];
      };

      expect(result.disabledServers).toEqual(["server1", "server2"]);
    });
  });

  describe("settings.mcp.setDisabled", () => {
    test("sets list of disabled servers", async () => {
      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.mcp.setDisabled",
        {
          disabledServers: ["server1", "server2", "server3"],
        },
      )) as { success: boolean };

      expect(result.success).toBe(true);

      // Verify set
      const getResult = (await callRPCHandler(
        ctx.messageHub,
        "settings.mcp.getDisabled",
        {},
      )) as {
        disabledServers: string[];
      };
      expect(getResult.disabledServers).toEqual([
        "server1",
        "server2",
        "server3",
      ]);
    });

    test("replaces existing disabled servers", async () => {
      await callRPCHandler(ctx.messageHub, "settings.mcp.setDisabled", {
        disabledServers: ["old-server"],
      });

      await callRPCHandler(ctx.messageHub, "settings.mcp.setDisabled", {
        disabledServers: ["new-server1", "new-server2"],
      });

      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.mcp.getDisabled",
        {},
      )) as {
        disabledServers: string[];
      };
      expect(result.disabledServers).toEqual(["new-server1", "new-server2"]);
      expect(result.disabledServers).not.toContain("old-server");
    });
  });

  describe("settings.fileOnly.read", () => {
    test("returns empty object if file does not exist", async () => {
      const result = await callRPCHandler(
        ctx.messageHub,
        "settings.fileOnly.read",
        {},
      );

      expect(result).toEqual({});
    });

    test("reads disabledMcpServers from file", async () => {
      // Write settings via toggle (which writes to file)
      await callRPCHandler(ctx.messageHub, "settings.mcp.toggle", {
        serverName: "server1",
        enabled: false,
      });

      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.fileOnly.read",
        {},
      )) as {
        disabledMcpServers?: string[];
      };

      expect(result.disabledMcpServers).toContain("server1");
    });
  });

  describe("showArchived Setting", () => {
    test("defaults to false", async () => {
      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.global.get",
        {},
      )) as GlobalSettings;

      expect(result.showArchived).toBe(false);
    });

    test("can be updated", async () => {
      const result = (await callRPCHandler(
        ctx.messageHub,
        "settings.global.update",
        {
          updates: { showArchived: true },
        },
      )) as { success: boolean; settings: GlobalSettings };

      expect(result.success).toBe(true);
      expect(result.settings.showArchived).toBe(true);
    });

    test("persists to database", async () => {
      await callRPCHandler(ctx.messageHub, "settings.global.update", {
        updates: { showArchived: true },
      });

      // Verify persisted
      const loaded = ctx.db.getGlobalSettings();
      expect(loaded.showArchived).toBe(true);
    });

    test("can be toggled multiple times", async () => {
      // Toggle on
      await callRPCHandler(ctx.messageHub, "settings.global.update", {
        updates: { showArchived: true },
      });
      let settings = ctx.db.getGlobalSettings();
      expect(settings.showArchived).toBe(true);

      // Toggle off
      await callRPCHandler(ctx.messageHub, "settings.global.update", {
        updates: { showArchived: false },
      });
      settings = ctx.db.getGlobalSettings();
      expect(settings.showArchived).toBe(false);

      // Toggle on again
      await callRPCHandler(ctx.messageHub, "settings.global.update", {
        updates: { showArchived: true },
      });
      settings = ctx.db.getGlobalSettings();
      expect(settings.showArchived).toBe(true);
    });
  });

  describe("Complete Flow", () => {
    test("update settings → persist to DB → write to file", async () => {
      // 1. Update settings via RPC
      await callRPCHandler(ctx.messageHub, "settings.global.update", {
        updates: {
          model: "claude-opus-4-5-20251101",
          disabledMcpServers: ["server1", "server2"],
        },
      });

      // 2. Verify persisted to database
      const dbSettings = ctx.db.getGlobalSettings();
      expect(dbSettings.model).toBe("claude-opus-4-5-20251101");
      expect(dbSettings.disabledMcpServers).toEqual(["server1", "server2"]);

      // 3. Prepare SDK options (triggers file write)
      await ctx.settingsManager.prepareSDKOptions();

      // 4. Verify written to file
      const settingsPath = join(workspacePath, ".claude/settings.local.json");
      expect(existsSync(settingsPath)).toBe(true);

      const fileContent = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(fileContent.disabledMcpjsonServers).toEqual([
        "server1",
        "server2",
      ]);
    });

    test("multiple concurrent updates are handled correctly", async () => {
      // Fire multiple updates concurrently
      await Promise.all([
        callRPCHandler(ctx.messageHub, "settings.global.update", {
          updates: { model: "claude-opus-4-5-20251101" },
        }),
        callRPCHandler(ctx.messageHub, "settings.mcp.toggle", {
          serverName: "server1",
          enabled: false,
        }),
        callRPCHandler(ctx.messageHub, "settings.mcp.toggle", {
          serverName: "server2",
          enabled: false,
        }),
      ]);

      // Verify final state is consistent
      const settings = (await callRPCHandler(
        ctx.messageHub,
        "settings.global.get",
        {},
      )) as GlobalSettings;
      expect(settings.model).toBe("claude-opus-4-5-20251101");
      expect(settings.disabledMcpServers).toContain("server1");
      expect(settings.disabledMcpServers).toContain("server2");
    });
  });
});
