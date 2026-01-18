/**
 * Worktree Isolation Tests
 *
 * Verifies that worktree sessions:
 * 1. Write MCP settings to their own .claude/settings.local.json (not root)
 * 2. Have their SDK query restricted to the worktree directory only
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../../src/storage/database";
import { SettingsManager } from "../../../../src/lib/settings-manager";

describe("Worktree Isolation", () => {
  let testDir: string;
  let db: Database;
  let rootWorkspace: string;
  let worktreePath: string;

  beforeEach(async () => {
    // Create test directory
    testDir = mkdtempSync(join(tmpdir(), "worktree-isolation-test-"));

    // Create database
    const dbPath = join(testDir, "test.db");
    db = new Database(dbPath);
    await db.initialize();

    // Create root workspace and worktree
    rootWorkspace = join(testDir, "root-workspace");
    worktreePath = join(testDir, "worktree-workspace");
    mkdirSync(rootWorkspace, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("SettingsManager writes to session workspace path, not global root", async () => {
    // Create SettingsManager instances for both workspaces
    const _rootSettings = new SettingsManager(db, rootWorkspace);
    const worktreeSettings = new SettingsManager(db, worktreePath);

    // Write MCP settings via worktree SettingsManager
    await worktreeSettings.setDisabledMcpServers(["chrome-devtools"]);

    // Verify settings written to worktree, NOT root
    const worktreeSettingsPath = join(
      worktreePath,
      ".claude/settings.local.json",
    );
    const rootSettingsPath = join(rootWorkspace, ".claude/settings.local.json");

    expect(existsSync(worktreeSettingsPath)).toBe(true);
    expect(existsSync(rootSettingsPath)).toBe(false);

    // Verify content is correct
    const worktreeContent = JSON.parse(
      readFileSync(worktreeSettingsPath, "utf-8"),
    );
    expect(worktreeContent.disabledMcpjsonServers).toEqual(["chrome-devtools"]);
  });

  test("Multiple worktree sessions maintain independent settings", async () => {
    // Create two worktree paths
    const worktree1 = join(testDir, "worktree-1");
    const worktree2 = join(testDir, "worktree-2");
    mkdirSync(worktree1, { recursive: true });
    mkdirSync(worktree2, { recursive: true });

    // Create SettingsManager for each
    const settings1 = new SettingsManager(db, worktree1);
    const settings2 = new SettingsManager(db, worktree2);

    // Set different disabled servers for each
    await settings1.setDisabledMcpServers(["chrome-devtools"]);
    await settings2.setDisabledMcpServers(["shadcn"]);

    // Verify each has its own settings file
    const settings1Path = join(worktree1, ".claude/settings.local.json");
    const settings2Path = join(worktree2, ".claude/settings.local.json");

    expect(existsSync(settings1Path)).toBe(true);
    expect(existsSync(settings2Path)).toBe(true);

    // Verify contents are independent
    const content1 = JSON.parse(readFileSync(settings1Path, "utf-8"));
    const content2 = JSON.parse(readFileSync(settings2Path, "utf-8"));

    expect(content1.disabledMcpjsonServers).toEqual(["chrome-devtools"]);
    expect(content2.disabledMcpjsonServers).toEqual(["shadcn"]);
  });

  test("SettingsManager preserves existing settings when updating MCP servers", async () => {
    // Create worktree workspace with existing settings
    const settingsPath = join(worktreePath, ".claude/settings.local.json");
    mkdirSync(join(worktreePath, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        outputStyle: "simple",
        attribution: { commit: "abc123" },
        customField: "preserved",
      }),
    );

    // Create SettingsManager and update MCP servers
    const settings = new SettingsManager(db, worktreePath);
    await settings.setDisabledMcpServers(["chrome-devtools"]);

    // Verify existing settings preserved
    const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(content.outputStyle).toBe("simple");
    expect(content.attribution).toEqual({ commit: "abc123" });
    expect(content.customField).toBe("preserved");
    expect(content.disabledMcpjsonServers).toEqual(["chrome-devtools"]);
  });

  test("prepareSDKOptions writes to correct workspace path", async () => {
    const settings = new SettingsManager(db, worktreePath);

    // Update global settings to include disabled MCP servers
    db.updateGlobalSettings({ disabledMcpServers: ["chrome-devtools"] });

    // Prepare SDK options (this should write file-only settings)
    await settings.prepareSDKOptions();

    // Verify settings written to worktree
    const settingsPath = join(worktreePath, ".claude/settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);

    const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(content.disabledMcpjsonServers).toEqual(["chrome-devtools"]);
  });

  test("SettingsManager.readFileOnlySettings reads from correct workspace", async () => {
    // Write settings to worktree
    const settingsPath = join(worktreePath, ".claude/settings.local.json");
    mkdirSync(join(worktreePath, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        disabledMcpjsonServers: ["chrome-devtools"],
        outputStyle: "detailed",
      }),
    );

    // Create SettingsManager for worktree
    const settings = new SettingsManager(db, worktreePath);
    const fileSettings = settings.readFileOnlySettings();

    expect(fileSettings.disabledMcpServers).toEqual(["chrome-devtools"]);
    expect(fileSettings.outputStyle).toBe("detailed");
  });

  test("listMcpServersFromSources reads from session workspace, not root", async () => {
    // Create .mcp.json in worktree
    const mcpPath = join(worktreePath, ".mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "worktree-server": {
            command: "npx",
            args: ["worktree-mcp"],
          },
        },
      }),
    );

    // Create .mcp.json in root (should NOT be read)
    const rootMcpPath = join(rootWorkspace, ".mcp.json");
    mkdirSync(rootWorkspace, { recursive: true });
    writeFileSync(
      rootMcpPath,
      JSON.stringify({
        mcpServers: {
          "root-server": {
            command: "npx",
            args: ["root-mcp"],
          },
        },
      }),
    );

    // Create SettingsManager for worktree
    const settings = new SettingsManager(db, worktreePath);
    const servers = settings.listMcpServersFromSources();

    // Should find worktree server, NOT root server
    expect(servers.project.length).toBe(1);
    expect(servers.project[0].name).toBe("worktree-server");
  });
});
