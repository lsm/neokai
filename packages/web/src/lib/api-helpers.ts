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
	GetSessionResponse,
	ListSessionsResponse,
	UpdateSessionRequest,
	ArchiveSessionResponse,
	ReadFileRequest,
	ReadFileResponse,
	ListFilesRequest,
	ListFilesResponse,
	GetFileTreeRequest,
	GetFileTreeResponse,
	GetAuthStatusResponse,
	DaemonConfig,
	HealthStatus,
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

export async function getSession(sessionId: string): Promise<GetSessionResponse> {
	const hub = getHubOrThrow();
	return await hub.call<GetSessionResponse>('session.get', { sessionId });
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

// ==================== Message Operations ====================

export async function getSDKMessages(
	sessionId: string,
	params?: {
		limit?: number;
		before?: number; // Cursor: get messages older than this timestamp (ms)
		since?: number; // Get messages newer than this timestamp (ms)
	}
): Promise<{ sdkMessages: unknown[] }> {
	const hub = getHubOrThrow();
	return await hub.call<{ sdkMessages: unknown[] }>('message.sdkMessages', {
		sessionId,
		...params,
	});
}

export async function getMessageCount(sessionId: string): Promise<{ count: number }> {
	const hub = getHubOrThrow();
	return await hub.call<{ count: number }>('message.count', { sessionId });
}

// ==================== Command Operations ====================

export async function getSlashCommands(sessionId: string): Promise<{ commands: string[] }> {
	const hub = getHubOrThrow();
	return await hub.call<{ commands: string[] }>('commands.list', { sessionId });
}

// ==================== File Operations ====================

export async function readFile(sessionId: string, req: ReadFileRequest): Promise<ReadFileResponse> {
	const hub = getHubOrThrow();
	return await hub.call<ReadFileResponse>('file.read', {
		sessionId,
		...req,
	});
}

export async function listFiles(
	sessionId: string,
	req: ListFilesRequest
): Promise<ListFilesResponse> {
	const hub = getHubOrThrow();
	return await hub.call<ListFilesResponse>('file.list', {
		sessionId,
		...req,
	});
}

export async function getFileTree(
	sessionId: string,
	req: GetFileTreeRequest
): Promise<GetFileTreeResponse> {
	const hub = getHubOrThrow();
	return await hub.call<GetFileTreeResponse>('file.tree', {
		sessionId,
		...req,
	});
}

// ==================== System Operations ====================

export async function health(): Promise<HealthStatus> {
	const hub = getHubOrThrow();
	return await hub.call<HealthStatus>('system.health');
}

export async function getConfig(): Promise<DaemonConfig> {
	const hub = getHubOrThrow();
	return await hub.call<DaemonConfig>('system.config');
}

// ==================== Authentication ====================

export async function getAuthStatus(): Promise<GetAuthStatusResponse> {
	const hub = getHubOrThrow();
	return await hub.call<GetAuthStatusResponse>('auth.status');
}

// ==================== Settings Operations ====================

export async function getGlobalSettings(): Promise<import('@liuboer/shared').GlobalSettings> {
	const hub = await connectionManager.getHub();
	return await hub.call<import('@liuboer/shared').GlobalSettings>('settings.global.get');
}

export async function updateGlobalSettings(
	updates: Partial<import('@liuboer/shared').GlobalSettings>
): Promise<{ success: boolean; settings: import('@liuboer/shared').GlobalSettings }> {
	const hub = await connectionManager.getHub();
	return await hub.call<{ success: boolean; settings: import('@liuboer/shared').GlobalSettings }>(
		'settings.global.update',
		{ updates }
	);
}

export async function toggleMcpServer(
	serverName: string,
	enabled: boolean
): Promise<{ success: boolean }> {
	const hub = await connectionManager.getHub();
	return await hub.call<{ success: boolean }>('settings.mcp.toggle', { serverName, enabled });
}

export async function getDisabledMcpServers(): Promise<{ disabledServers: string[] }> {
	const hub = await connectionManager.getHub();
	return await hub.call<{ disabledServers: string[] }>('settings.mcp.getDisabled');
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

export async function listMcpServersFromSources(): Promise<McpServersFromSourcesResponse> {
	const hub = await connectionManager.getHub();
	return await hub.call<McpServersFromSourcesResponse>('settings.mcp.listFromSources');
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
