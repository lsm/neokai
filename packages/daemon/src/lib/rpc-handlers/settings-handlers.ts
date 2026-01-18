/**
 * Settings RPC Handlers
 *
 * Provides RPC methods for managing global and session-specific settings.
 */

import type { MessageHub } from "@liuboer/shared";
import type { DaemonHub } from "../daemon-hub";
import type { GlobalSettings, SessionSettings } from "@liuboer/shared";
import type { SettingsManager } from "../settings-manager";
import type { Database } from "../../storage/database";

export function registerSettingsHandlers(
  messageHub: MessageHub,
  settingsManager: SettingsManager,
  daemonHub: DaemonHub,
  db: Database,
) {
  /**
   * Get global settings
   */
  messageHub.handle("settings.global.get", async () => {
    return settingsManager.getGlobalSettings();
  });

  /**
   * Update global settings (partial update)
   */
  messageHub.handle(
    "settings.global.update",
    async (data: { updates: Partial<GlobalSettings> }) => {
      const updated = settingsManager.updateGlobalSettings(data.updates);
      // Emit event for StateManager to broadcast (global event)
      daemonHub.emit("settings.updated", {
        sessionId: "global",
        settings: updated,
      });

      // SPECIAL CASE: If showArchived changed, also broadcast sessions change
      // because the filtered session list needs to update
      if ("showArchived" in data.updates) {
        daemonHub.emit("sessions.filterChanged", { sessionId: "global" });
      }

      return { success: true, settings: updated };
    },
  );

  /**
   * Save global settings (full replace)
   */
  messageHub.handle(
    "settings.global.save",
    async (data: { settings: GlobalSettings }) => {
      settingsManager.saveGlobalSettings(data.settings);
      // Emit event for StateManager to broadcast (global event)
      daemonHub.emit("settings.updated", {
        sessionId: "global",
        settings: data.settings,
      });
      return { success: true };
    },
  );

  /**
   * Toggle MCP server enabled/disabled
   */
  messageHub.handle(
    "settings.mcp.toggle",
    async (data: { serverName: string; enabled: boolean }) => {
      await settingsManager.toggleMcpServer(data.serverName, data.enabled);
      // Emit event for StateManager to broadcast (global event)
      const settings = settingsManager.getGlobalSettings();
      daemonHub.emit("settings.updated", { sessionId: "global", settings });
      return { success: true };
    },
  );

  /**
   * Get list of disabled MCP servers
   */
  messageHub.handle("settings.mcp.getDisabled", async () => {
    return {
      disabledServers: settingsManager.getDisabledMcpServers(),
    };
  });

  /**
   * Set list of disabled MCP servers
   */
  messageHub.handle(
    "settings.mcp.setDisabled",
    async (data: { disabledServers: string[] }) => {
      await settingsManager.setDisabledMcpServers(data.disabledServers);
      // Emit event for StateManager to broadcast (global event)
      const settings = settingsManager.getGlobalSettings();
      daemonHub.emit("settings.updated", { sessionId: "global", settings });
      return { success: true };
    },
  );

  /**
   * Read file-only settings from .claude/settings.local.json
   */
  messageHub.handle("settings.fileOnly.read", async () => {
    return settingsManager.readFileOnlySettings();
  });

  /**
   * List MCP servers from enabled setting sources
   *
   * IMPORTANT: Reads from session-specific workspace path for worktree isolation.
   * - If sessionId provided: Reads from session's workspace (worktree or shared)
   * - If sessionId omitted: Reads from global workspace root (for GlobalSettingsEditor)
   */
  messageHub.handle(
    "settings.mcp.listFromSources",
    async (data?: { sessionId?: string }) => {
      let effectiveSettings = settingsManager; // Default: global workspace root

      // If sessionId provided, use session-specific workspace path
      if (data?.sessionId) {
        const session = db.getSession(data.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${data.sessionId}`);
        }

        // Create session-specific SettingsManager with session's workspace path
        // This ensures we read .mcp.json and settings files from the correct location:
        // - Worktree sessions: .worktrees/{sessionId}/.mcp.json
        // - Non-worktree sessions: {workspaceRoot}/.mcp.json
        effectiveSettings = new (
          await import("../settings-manager")
        ).SettingsManager(db, session.workspacePath);
      }

      return {
        servers: effectiveSettings.listMcpServersFromSources(),
        serverSettings: settingsManager.getMcpServerSettings(), // Global server settings
      };
    },
  );

  /**
   * Update per-server MCP settings (allowed/defaultOn)
   */
  messageHub.handle(
    "settings.mcp.updateServerSettings",
    async (data: {
      serverName: string;
      settings: { allowed?: boolean; defaultOn?: boolean };
    }) => {
      settingsManager.updateMcpServerSettings(data.serverName, data.settings);
      // Emit event for StateManager to broadcast (global event)
      const settings = settingsManager.getGlobalSettings();
      daemonHub.emit("settings.updated", { sessionId: "global", settings });
      return { success: true };
    },
  );

  /**
   * Get session settings (placeholder for future session-specific settings)
   *
   * Currently, session settings are stored in session.config, but this
   * handler provides a unified interface for future expansion.
   */
  messageHub.handle(
    "settings.session.get",
    async (data: { sessionId: string }) => {
      // Future: retrieve session-specific settings
      // For now, return empty object
      return {
        sessionId: data.sessionId,
        settings: {},
      };
    },
  );

  /**
   * Update session settings (placeholder for future session-specific settings)
   */
  messageHub.handle(
    "settings.session.update",
    async (data: { sessionId: string; updates: Partial<SessionSettings> }) => {
      // Future: update session-specific settings
      // For now, return success
      return {
        success: true,
        sessionId: data.sessionId,
      };
    },
  );
}
