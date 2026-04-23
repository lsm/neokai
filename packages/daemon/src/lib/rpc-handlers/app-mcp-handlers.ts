/**
 * App MCP RPC Handlers
 *
 * Contains two sets of handlers:
 *
 * 1. App MCP Registry RPC Handlers (registerAppMcpHandlers)
 *    Exposes the application-level MCP server registry via RPC:
 *    - mcp.registry.list       — list all registry entries
 *    - mcp.registry.get        — get a single entry by id
 *    - mcp.registry.create     — add a new entry, emit mcp.registry.changed
 *    - mcp.registry.update     — update an entry, emit mcp.registry.changed
 *    - mcp.registry.delete     — remove an entry, emit mcp.registry.changed
 *    - mcp.registry.setEnabled — toggle enabled flag, emit mcp.registry.changed
 *
 *    Note: mcp.registry.listErrors is registered in mcp-handlers.ts (requires
 *    the concrete AppMcpLifecycleManager).
 *
 * 2. Per-Room MCP Enablement RPC Handlers (setupAppMcpHandlers)
 *    Provides RPC methods for managing per-room MCP enablement overrides:
 *    - mcp.room.getEnabled    — list server IDs enabled for a room
 *    - mcp.room.setEnabled    — upsert an enablement override for one server
 *    - mcp.room.resetToGlobal — remove all per-room overrides for a room
 *
 *    Each mutating handler emits `mcp.registry.changed` so that daemon-internal
 *    components (e.g., the lifecycle manager) can hot-reload configuration.
 */

import type { MessageHub } from '@neokai/shared';
import type {
	AppMcpServer,
	CreateAppMcpServerRequest,
	UpdateAppMcpServerRequest,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository';
import type { Database } from '../../storage/database';
import type {
	McpEnablementClearOverrideRequest,
	McpEnablementClearOverrideResponse,
	McpEnablementClearScopeRequest,
	McpEnablementClearScopeResponse,
	McpEnablementListRequest,
	McpEnablementListResponse,
	McpEnablementSetOverrideRequest,
	McpEnablementSetOverrideResponse,
	McpRoomGetEnabledRequest,
	McpRoomGetEnabledResponse,
	McpRoomSetEnabledRequest,
	McpRoomSetEnabledResponse,
	McpRoomResetToGlobalRequest,
	McpRoomResetToGlobalResponse,
} from '@neokai/shared';
import { Logger } from '../logger';

const log = new Logger('app-mcp-handlers');

// ---------------------------------------------------------------------------
// Registry handler context
// ---------------------------------------------------------------------------

export interface AppMcpHandlerContext {
	db: { appMcpServers: AppMcpServerRepository };
	daemonHub: DaemonHub;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitChanged(daemonHub: DaemonHub): void {
	daemonHub.emit('mcp.registry.changed', { sessionId: 'global' }).catch((err) => {
		log.warn('Failed to emit mcp.registry.changed:', err);
	});
}

// ---------------------------------------------------------------------------
// Registry handler registration
// ---------------------------------------------------------------------------

export function registerAppMcpHandlers(messageHub: MessageHub, ctx: AppMcpHandlerContext): void {
	const { db, daemonHub } = ctx;

	// mcp.registry.list — returns AppMcpServer[]
	messageHub.onRequest('mcp.registry.list', async () => {
		const servers = db.appMcpServers.list();
		return { servers } satisfies { servers: AppMcpServer[] };
	});

	// mcp.registry.get — fetch a single entry by id
	messageHub.onRequest('mcp.registry.get', async (data) => {
		const { id } = data as { id: string };

		if (!id) {
			throw new Error('id is required');
		}

		const server = db.appMcpServers.get(id);
		if (!server) {
			throw new Error(`MCP server not found: ${id}`);
		}

		return { server } satisfies { server: AppMcpServer };
	});

	// mcp.registry.create — validates input, creates entry, emits event
	messageHub.onRequest('mcp.registry.create', async (data) => {
		const params = data as CreateAppMcpServerRequest;

		if (!params.name || params.name.trim() === '') {
			throw new Error('name is required');
		}
		if (!params.sourceType) {
			throw new Error('sourceType is required');
		}

		const server = db.appMcpServers.create(params);
		emitChanged(daemonHub);
		log.info(`mcp.registry.create: created entry "${server.name}" (${server.id})`);
		return { server } satisfies { server: AppMcpServer };
	});

	// mcp.registry.update — updates entry, emits event, returns updated entry
	messageHub.onRequest('mcp.registry.update', async (data) => {
		const params = data as UpdateAppMcpServerRequest;

		if (!params.id) {
			throw new Error('id is required');
		}

		const { id, ...updates } = params;
		const server = db.appMcpServers.update(id, updates);
		if (!server) {
			throw new Error(`MCP server not found: ${id}`);
		}

		// Only emit if there were actual fields to update — the repo short-circuits
		// and skips the write when updates is empty, so avoid a spurious event.
		if (Object.keys(updates).length > 0) {
			emitChanged(daemonHub);
		}
		log.info(`mcp.registry.update: updated entry "${server.name}" (${id})`);
		return { server } satisfies { server: AppMcpServer };
	});

	// mcp.registry.delete — removes entry, emits event
	messageHub.onRequest('mcp.registry.delete', async (data) => {
		const { id } = data as { id: string };

		if (!id) {
			throw new Error('id is required');
		}

		const deleted = db.appMcpServers.delete(id);
		if (!deleted) {
			throw new Error(`MCP server not found: ${id}`);
		}

		emitChanged(daemonHub);
		log.info(`mcp.registry.delete: deleted entry ${id}`);
		return { success: true } satisfies { success: boolean };
	});

	// mcp.registry.setEnabled — convenience toggle for the enabled field
	messageHub.onRequest('mcp.registry.setEnabled', async (data) => {
		const { id, enabled } = data as { id: string; enabled: boolean };

		if (!id) {
			throw new Error('id is required');
		}
		if (typeof enabled !== 'boolean') {
			throw new Error('enabled must be a boolean');
		}

		const server = db.appMcpServers.update(id, { enabled });
		if (!server) {
			throw new Error(`MCP server not found: ${id}`);
		}

		emitChanged(daemonHub);
		log.info(`mcp.registry.setEnabled: set entry ${id} enabled=${enabled}`);
		return { server } satisfies { server: AppMcpServer };
	});
}

// ---------------------------------------------------------------------------
// Per-room enablement handler registration
// ---------------------------------------------------------------------------

export function setupAppMcpHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	db: Database
): void {
	/**
	 * Get the IDs of all MCP servers that are explicitly enabled for a room.
	 * Only returns servers with an explicit override row; servers with no override
	 * are not included (consumers should treat them as following global defaults).
	 */
	messageHub.onRequest('mcp.room.getEnabled', (data) => {
		const { roomId } = data as McpRoomGetEnabledRequest;
		const serverIds = db.roomMcpEnablement.getEnabledServerIds(roomId);
		return { serverIds } satisfies McpRoomGetEnabledResponse;
	});

	/**
	 * Upsert an enablement override for a single MCP server in a room.
	 * Emits `mcp.registry.changed` after writing.
	 */
	messageHub.onRequest('mcp.room.setEnabled', (data) => {
		const { roomId, serverId, enabled } = data as McpRoomSetEnabledRequest;

		// Validate that the server exists
		const server = db.appMcpServers.get(serverId);
		if (!server) {
			throw new Error(`MCP server not found: ${serverId}`);
		}

		db.roomMcpEnablement.setEnabled(roomId, serverId, enabled);

		daemonHub
			.emit('mcp.registry.changed', { sessionId: 'global' })
			.catch((err) => log.warn('Failed to emit mcp.registry.changed:', err));

		return { ok: true } satisfies McpRoomSetEnabledResponse;
	});

	/**
	 * Remove all per-room enablement overrides for a room, reverting to global defaults.
	 * Emits `mcp.registry.changed` after writing.
	 */
	messageHub.onRequest('mcp.room.resetToGlobal', (data) => {
		const { roomId } = data as McpRoomResetToGlobalRequest;

		db.roomMcpEnablement.resetToGlobal(roomId);

		daemonHub
			.emit('mcp.registry.changed', { sessionId: 'global' })
			.catch((err) => log.warn('Failed to emit mcp.registry.changed:', err));

		return { ok: true } satisfies McpRoomResetToGlobalResponse;
	});

	// -------------------------------------------------------------------------
	// Scope-aware enablement handlers (M3+)
	//
	// These operate on the unified `mcp_enablement` table and support all three
	// scope types (space / room / session). The older `mcp.room.*` handlers
	// above still target the legacy `room_mcp_enablement` table and will be
	// removed in M5.
	// -------------------------------------------------------------------------

	/** `mcp.enablement.list` — every override at a given scope. */
	messageHub.onRequest('mcp.enablement.list', (data) => {
		const { scopeType, scopeId } = data as McpEnablementListRequest;
		if (!scopeType) throw new Error('scopeType is required');
		if (!scopeId) throw new Error('scopeId is required');
		const overrides = db.mcpEnablement.listForScope(scopeType, scopeId);
		return { overrides } satisfies McpEnablementListResponse;
	});

	/** `mcp.enablement.setOverride` — upsert a single override. */
	messageHub.onRequest('mcp.enablement.setOverride', (data) => {
		const { scopeType, scopeId, serverId, enabled } = data as McpEnablementSetOverrideRequest;
		if (!scopeType) throw new Error('scopeType is required');
		if (!scopeId) throw new Error('scopeId is required');
		if (!serverId) throw new Error('serverId is required');
		if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');

		// Validate that the server exists — otherwise the FK CASCADE is the only
		// guard and callers get a useless SQL error.
		const server = db.appMcpServers.get(serverId);
		if (!server) {
			throw new Error(`MCP server not found: ${serverId}`);
		}

		const override = db.mcpEnablement.setOverride(scopeType, scopeId, serverId, enabled);

		daemonHub
			.emit('mcp.registry.changed', { sessionId: 'global' })
			.catch((err) => log.warn('Failed to emit mcp.registry.changed:', err));

		return { override } satisfies McpEnablementSetOverrideResponse;
	});

	/** `mcp.enablement.clearOverride` — delete one override row. */
	messageHub.onRequest('mcp.enablement.clearOverride', (data) => {
		const { scopeType, scopeId, serverId } = data as McpEnablementClearOverrideRequest;
		if (!scopeType) throw new Error('scopeType is required');
		if (!scopeId) throw new Error('scopeId is required');
		if (!serverId) throw new Error('serverId is required');

		const deleted = db.mcpEnablement.clearOverride(scopeType, scopeId, serverId);
		if (deleted) {
			daemonHub
				.emit('mcp.registry.changed', { sessionId: 'global' })
				.catch((err) => log.warn('Failed to emit mcp.registry.changed:', err));
		}
		return { deleted } satisfies McpEnablementClearOverrideResponse;
	});

	/** `mcp.enablement.clearScope` — delete every override at a given scope. */
	messageHub.onRequest('mcp.enablement.clearScope', (data) => {
		const { scopeType, scopeId } = data as McpEnablementClearScopeRequest;
		if (!scopeType) throw new Error('scopeType is required');
		if (!scopeId) throw new Error('scopeId is required');

		const deleted = db.mcpEnablement.clearScope(scopeType, scopeId);
		if (deleted > 0) {
			daemonHub
				.emit('mcp.registry.changed', { sessionId: 'global' })
				.catch((err) => log.warn('Failed to emit mcp.registry.changed:', err));
		}
		return { deleted } satisfies McpEnablementClearScopeResponse;
	});
}
