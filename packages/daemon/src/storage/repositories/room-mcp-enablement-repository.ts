/**
 * RoomMcpEnablementRepository
 *
 * Stores per-room overrides for which application-level MCP servers are enabled.
 * Each write calls reactiveDb.notifyChange('room_mcp_enablement') so that
 * LiveQueryEngine can invalidate frontend subscriptions on every change.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { AppMcpServer, AppMcpServerSourceType } from '@neokai/shared';
import type { ReactiveDatabase } from '../reactive-database';

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface EnablementRow {
	room_id: string;
	server_id: string;
	enabled: number;
}

interface EnablementWithServerRow {
	server_id: string;
	enabled: number;
	name: string;
	source_type: string;
	description: string | null;
	command: string | null;
	args: string | null;
	env: string | null;
	url: string | null;
	headers: string | null;
	created_at: number | null;
	updated_at: number | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class RoomMcpEnablementRepository {
	constructor(
		private db: BunDatabase,
		private reactiveDb: ReactiveDatabase
	) {}

	/**
	 * Upsert an enablement override for a single server in a room.
	 * Calling with enabled=true or enabled=false sets an explicit override.
	 * Use resetToGlobal() to remove overrides entirely.
	 */
	setEnabled(roomId: string, serverId: string, enabled: boolean): void {
		this.db
			.prepare(
				`INSERT INTO room_mcp_enablement (room_id, server_id, enabled)
         VALUES (?, ?, ?)
         ON CONFLICT(room_id, server_id) DO UPDATE SET enabled = excluded.enabled`
			)
			.run(roomId, serverId, enabled ? 1 : 0);
		this.reactiveDb.notifyChange('room_mcp_enablement');
	}

	/**
	 * Returns the server IDs that are explicitly marked enabled for a room.
	 * Servers with no override row are not included.
	 */
	getEnabledServerIds(roomId: string): string[] {
		const rows = this.db
			.prepare(`SELECT server_id FROM room_mcp_enablement WHERE room_id = ? AND enabled = 1`)
			.all(roomId) as Array<{ server_id: string }>;
		return rows.map((r) => r.server_id);
	}

	/**
	 * Returns full AppMcpServer entries for servers explicitly enabled for a room,
	 * by joining room_mcp_enablement with app_mcp_servers.
	 */
	getEnabledServers(roomId: string): AppMcpServer[] {
		const rows = this.db
			.prepare(
				`SELECT
          rme.server_id,
          rme.enabled,
          ams.name,
          ams.source_type,
          ams.description,
          ams.command,
          ams.args,
          ams.env,
          ams.url,
          ams.headers,
          ams.created_at,
          ams.updated_at
        FROM room_mcp_enablement rme
        JOIN app_mcp_servers ams ON ams.id = rme.server_id
        WHERE rme.room_id = ? AND rme.enabled = 1`
			)
			.all(roomId) as EnablementWithServerRow[];

		return rows.map((row) => rowToServer(row));
	}

	/**
	 * Remove all per-room overrides for a room, reverting to global defaults.
	 */
	resetToGlobal(roomId: string): void {
		this.db.prepare(`DELETE FROM room_mcp_enablement WHERE room_id = ?`).run(roomId);
		this.reactiveDb.notifyChange('room_mcp_enablement');
	}

	/**
	 * Get the raw enablement row for a specific (roomId, serverId) pair.
	 * Returns null if no override exists.
	 */
	getOverride(roomId: string, serverId: string): { enabled: boolean } | null {
		const row = this.db
			.prepare(`SELECT enabled FROM room_mcp_enablement WHERE room_id = ? AND server_id = ?`)
			.get(roomId, serverId) as EnablementRow | undefined;
		if (!row) return null;
		return { enabled: row.enabled === 1 };
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToServer(row: EnablementWithServerRow): AppMcpServer {
	return {
		id: row.server_id,
		name: row.name,
		...(row.description !== null ? { description: row.description } : {}),
		sourceType: row.source_type as AppMcpServerSourceType,
		...(row.command !== null ? { command: row.command } : {}),
		...(row.args !== null ? { args: JSON.parse(row.args) as string[] } : {}),
		...(row.env !== null ? { env: JSON.parse(row.env) as Record<string, string> } : {}),
		...(row.url !== null ? { url: row.url } : {}),
		...(row.headers !== null ? { headers: JSON.parse(row.headers) as Record<string, string> } : {}),
		enabled: true,
		...(row.created_at !== null ? { createdAt: row.created_at } : {}),
		...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
	};
}
