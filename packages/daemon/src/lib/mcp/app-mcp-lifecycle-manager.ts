/**
 * AppMcpLifecycleManager
 *
 * Converts application-level MCP registry entries into SDK McpServerConfig objects
 * ready for injection into agent sessions.
 *
 * Responsibilities:
 * - Reads the app_mcp_servers registry via the Database facade.
 * - Filters to enabled entries.
 * - Converts each entry to the appropriate SDK config type (stdio / sse / http).
 * - Validates entries and exposes startup errors for the UI warning badge.
 *
 * Health-checking and auto-restart are intentionally deferred to a future
 * iteration and MUST use JobQueueProcessor (following the github.poll pattern)
 * rather than setInterval or in-memory state.
 */

import type { Database } from '../../storage/database';
import type {
	AppMcpServer,
	McpServerConfig,
	McpStdioServerConfig,
	McpSSEServerConfig,
	McpHttpServerConfig,
	ValidationResult,
} from '@neokai/shared';

// Re-export so callers can import from this module without reaching into shared.
export type { ValidationResult } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpStartupError {
	serverId: string;
	name: string;
	error: string;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class AppMcpLifecycleManager {
	constructor(private readonly db: Database) {}

	/**
	 * Returns SDK MCP configs for all globally-enabled registry entries.
	 * Invalid entries (e.g. missing required fields) are silently skipped —
	 * call `getStartupErrors()` to surface them to the UI.
	 */
	getEnabledMcpConfigs(): Record<string, McpServerConfig> {
		const entries = this.db.appMcpServers.listEnabled();
		const result: Record<string, McpServerConfig> = {};

		for (const entry of entries) {
			const validation = this.validateEntry(entry);
			if (!validation.valid) {
				continue;
			}

			result[entry.name] = this.convertEntry(entry);
		}

		return result;
	}

	/**
	 * Returns SDK MCP configs for a specific room.
	 *
	 * Per-room overrides take precedence:
	 * - If the room has explicitly enabled servers (via room_mcp_enablement), return those.
	 * - If the room has no overrides, fall back to globally-enabled servers, but exclude
	 *   any that are explicitly disabled for this room via per-room override.
	 */
	getEnabledMcpConfigsForRoom(roomId: string): Record<string, McpServerConfig> {
		const roomServers = this.db.roomMcpEnablement.getEnabledServers(roomId);

		// If the room has per-room enabled servers, return those (filtered by validation).
		if (roomServers.length > 0) {
			const result: Record<string, McpServerConfig> = {};
			for (const entry of roomServers) {
				const validation = this.validateEntry(entry);
				if (!validation.valid) {
					continue;
				}
				result[entry.name] = this.convertEntry(entry);
			}
			return result;
		}

		// No per-room enabled servers. Fall back to global enabled set, but exclude
		// any servers that are explicitly disabled for this room.
		const globalServers = this.db.appMcpServers.listEnabled();
		const result: Record<string, McpServerConfig> = {};

		for (const entry of globalServers) {
			// Check if this server is explicitly disabled for the room
			const override = this.db.roomMcpEnablement.getOverride(roomId, entry.id);
			if (override !== null && !override.enabled) {
				// Server is explicitly disabled for this room — skip it
				continue;
			}

			const validation = this.validateEntry(entry);
			if (!validation.valid) {
				continue;
			}

			result[entry.name] = this.convertEntry(entry);
		}

		return result;
	}

	/**
	 * Validates a single registry entry, checking that required fields are
	 * present for its source type.
	 */
	validateEntry(entry: AppMcpServer): ValidationResult {
		switch (entry.sourceType) {
			case 'stdio':
				if (!entry.command || entry.command.trim() === '') {
					return {
						valid: false,
						error: `stdio server "${entry.name}" is missing required field: command`,
					};
				}
				return { valid: true };

			case 'sse':
				if (!entry.url || entry.url.trim() === '') {
					return {
						valid: false,
						error: `sse server "${entry.name}" is missing required field: url`,
					};
				}
				return { valid: true };

			case 'http':
				if (!entry.url || entry.url.trim() === '') {
					return {
						valid: false,
						error: `http server "${entry.name}" is missing required field: url`,
					};
				}
				return { valid: true };

			default: {
				const exhaustive: never = entry.sourceType;
				return {
					valid: false,
					error: `server "${entry.name}" has unknown sourceType: ${exhaustive}`,
				};
			}
		}
	}

	/**
	 * Returns all registry entries (enabled or disabled) that fail validation.
	 * Exposed via the `mcp.registry.listErrors` RPC so the UI can render a
	 * warning badge next to misconfigured entries.
	 */
	getStartupErrors(): McpStartupError[] {
		// Check all entries (not just enabled) so users can see invalid drafts too.
		const allEntries = this.db.appMcpServers.list();
		const errors: McpStartupError[] = [];

		for (const entry of allEntries) {
			const validation = this.validateEntry(entry);
			if (!validation.valid) {
				errors.push({
					serverId: entry.id,
					name: entry.name,
					error: validation.error ?? 'Unknown validation error',
				});
			}
		}

		return errors;
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private convertEntry(entry: AppMcpServer): McpServerConfig {
		switch (entry.sourceType) {
			case 'stdio': {
				const config: McpStdioServerConfig = {
					type: 'stdio',
					command: entry.command!,
					...(entry.args && entry.args.length > 0 ? { args: entry.args } : {}),
					...(entry.env && Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
				};
				return config;
			}

			case 'sse': {
				const config: McpSSEServerConfig = {
					type: 'sse',
					url: entry.url!,
					...(entry.headers && Object.keys(entry.headers).length > 0
						? { headers: entry.headers }
						: {}),
				};
				return config;
			}

			case 'http': {
				const config: McpHttpServerConfig = {
					type: 'http',
					url: entry.url!,
					...(entry.headers && Object.keys(entry.headers).length > 0
						? { headers: entry.headers }
						: {}),
				};
				return config;
			}

			default: {
				const exhaustive: never = entry.sourceType;
				throw new Error(`convertEntry: unhandled sourceType "${exhaustive}"`);
			}
		}
	}
}
