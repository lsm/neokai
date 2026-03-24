/**
 * App MCP Registry RPC Handlers
 *
 * Exposes the application-level MCP server registry via RPC:
 * - mcp.registry.list       — list all registry entries
 * - mcp.registry.get        — get a single entry by id
 * - mcp.registry.create     — add a new entry, emit mcp.registry.changed
 * - mcp.registry.update     — update an entry, emit mcp.registry.changed
 * - mcp.registry.delete     — remove an entry, emit mcp.registry.changed
 * - mcp.registry.setEnabled — toggle enabled flag, emit mcp.registry.changed
 *
 * Note: mcp.registry.listErrors is registered in mcp-handlers.ts (requires
 * the concrete AppMcpLifecycleManager).
 */

import type { MessageHub } from '@neokai/shared';
import type {
	AppMcpServer,
	CreateAppMcpServerRequest,
	UpdateAppMcpServerRequest,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository';
import { Logger } from '../logger';

const log = new Logger('app-mcp-handlers');

// ---------------------------------------------------------------------------
// Handler context
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
// Handler registration
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
