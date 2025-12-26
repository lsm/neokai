/**
 * API Helper Functions
 *
 * Typed convenience functions for common daemon operations.
 * These wrap MessageHub.call() with type safety and better DX.
 *
 * ## Non-Blocking Pattern:
 * All functions throw ConnectionNotReadyError immediately if not connected.
 * This prevents UI freezes when the connection is unstable.
 *
 * ## Usage:
 * ```typescript
 * try {
 *   const session = await createSession({ workspacePath: '/path' });
 * } catch (err) {
 *   if (err instanceof ConnectionNotReadyError) {
 *     toast.error('Not connected. Please wait...');
 *   } else {
 *     toast.error(err.message);
 *   }
 * }
 * ```
 */

import type {
	CreateSessionRequest,
	CreateSessionResponse,
	ListSessionsResponse,
	UpdateSessionRequest,
	ArchiveSessionResponse,
	GetAuthStatusResponse,
} from '@liuboer/shared';
import { connectionManager } from './connection-manager.ts';
import { ConnectionNotReadyError } from './errors.ts';

/**
 * Get hub or throw immediately (non-blocking helper)
 */
function getHubOrThrow() {
	const hub = connectionManager.getHubIfConnected();
	if (!hub) {
		throw new ConnectionNotReadyError('Not connected to server');
	}
	return hub;
}

// ==================== Session Operations ====================

export async function createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
	const hub = getHubOrThrow();
	return await hub.call<CreateSessionResponse>('session.create', req, {
		timeout: 15000,
	});
}

export async function listSessions(): Promise<ListSessionsResponse> {
	const hub = getHubOrThrow();
	return await hub.call<ListSessionsResponse>('session.list');
}

export async function updateSession(sessionId: string, req: UpdateSessionRequest): Promise<void> {
	const hub = getHubOrThrow();
	await hub.call('session.update', { sessionId, ...req });
}

export async function deleteSession(sessionId: string): Promise<void> {
	const hub = getHubOrThrow();
	await hub.call('session.delete', { sessionId });
}

export async function archiveSession(
	sessionId: string,
	confirmed = false
): Promise<ArchiveSessionResponse> {
	const hub = getHubOrThrow();
	return await hub.call<ArchiveSessionResponse>('session.archive', {
		sessionId,
		confirmed,
	});
}

// ==================== Authentication ====================

export async function getAuthStatus(): Promise<GetAuthStatusResponse> {
	const hub = getHubOrThrow();
	return await hub.call<GetAuthStatusResponse>('auth.status');
}

// ==================== Settings Operations ====================

export async function updateGlobalSettings(
	updates: Partial<import('@liuboer/shared').GlobalSettings>
): Promise<{ success: boolean; settings: import('@liuboer/shared').GlobalSettings }> {
	const hub = await connectionManager.getHub();
	return await hub.call<{ success: boolean; settings: import('@liuboer/shared').GlobalSettings }>(
		'settings.global.update',
		{ updates }
	);
}

export interface McpServerFromSource {
	name: string;
	source: import('@liuboer/shared').SettingSource;
	command?: string;
	args?: string[];
}

export interface McpServersFromSourcesResponse {
	servers: Record<import('@liuboer/shared').SettingSource, McpServerFromSource[]>;
	serverSettings: Record<string, { allowed?: boolean; defaultOn?: boolean }>;
}

export async function listMcpServersFromSources(
	sessionId?: string
): Promise<McpServersFromSourcesResponse> {
	const hub = await connectionManager.getHub();
	return await hub.call<McpServersFromSourcesResponse>(
		'settings.mcp.listFromSources',
		sessionId ? { sessionId } : {}
	);
}

export async function updateMcpServerSettings(
	serverName: string,
	settings: { allowed?: boolean; defaultOn?: boolean }
): Promise<{ success: boolean }> {
	const hub = await connectionManager.getHub();
	return await hub.call<{ success: boolean }>('settings.mcp.updateServerSettings', {
		serverName,
		settings,
	});
}
