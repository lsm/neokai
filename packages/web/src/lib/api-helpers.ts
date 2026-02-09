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
} from '@neokai/shared';
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
	return await hub.request<CreateSessionResponse>('session.create', req, {
		timeout: 15000,
	});
}

export async function listSessions(): Promise<ListSessionsResponse> {
	const hub = getHubOrThrow();
	return await hub.request<ListSessionsResponse>('session.list');
}

export async function updateSession(sessionId: string, req: UpdateSessionRequest): Promise<void> {
	const hub = getHubOrThrow();
	await hub.request('session.update', { sessionId, ...req });
}

export async function resetSessionQuery(
	sessionId: string
): Promise<{ success: boolean; error?: string }> {
	const hub = getHubOrThrow();
	return await hub.request<{ success: boolean; error?: string }>('session.resetQuery', {
		sessionId,
		restartQuery: true,
	});
}

export async function switchCoordinatorMode(
	sessionId: string,
	coordinatorMode: boolean
): Promise<{ success: boolean; coordinatorMode: boolean; error?: string }> {
	const hub = getHubOrThrow();
	return await hub.request<{ success: boolean; coordinatorMode: boolean; error?: string }>(
		'session.coordinator.switch',
		{ sessionId, coordinatorMode }
	);
}

export async function deleteSession(sessionId: string): Promise<void> {
	const hub = getHubOrThrow();
	await hub.request('session.delete', { sessionId });
}

export async function archiveSession(
	sessionId: string,
	confirmed = false
): Promise<ArchiveSessionResponse> {
	const hub = getHubOrThrow();
	return await hub.request<ArchiveSessionResponse>('session.archive', {
		sessionId,
		confirmed,
	});
}

// ==================== Authentication ====================

export async function getAuthStatus(): Promise<GetAuthStatusResponse> {
	const hub = getHubOrThrow();
	return await hub.request<GetAuthStatusResponse>('auth.status');
}

// ==================== Settings Operations ====================

export async function updateGlobalSettings(
	updates: Partial<import('@neokai/shared').GlobalSettings>
): Promise<{
	success: boolean;
	settings: import('@neokai/shared').GlobalSettings;
}> {
	const hub = await connectionManager.getHub();
	return await hub.request<{
		success: boolean;
		settings: import('@neokai/shared').GlobalSettings;
	}>('settings.global.update', { updates });
}

export interface McpServerFromSource {
	name: string;
	source: import('@neokai/shared').SettingSource;
	command?: string;
	args?: string[];
}

export interface McpServersFromSourcesResponse {
	servers: Record<import('@neokai/shared').SettingSource, McpServerFromSource[]>;
	serverSettings: Record<string, { allowed?: boolean; defaultOn?: boolean }>;
}

export async function listMcpServersFromSources(
	sessionId?: string
): Promise<McpServersFromSourcesResponse> {
	const hub = await connectionManager.getHub();
	return await hub.request<McpServersFromSourcesResponse>(
		'settings.mcp.listFromSources',
		sessionId ? { sessionId } : {}
	);
}

export async function updateMcpServerSettings(
	serverName: string,
	settings: { allowed?: boolean; defaultOn?: boolean }
): Promise<{ success: boolean }> {
	const hub = await connectionManager.getHub();
	return await hub.request<{ success: boolean }>('settings.mcp.updateServerSettings', {
		serverName,
		settings,
	});
}

// ==================== Rewind Operations ====================

export async function getRewindPoints(sessionId: string): Promise<{
	rewindPoints: Array<{ uuid: string; timestamp: number; content: string; turnNumber: number }>;
	error?: string;
}> {
	const hub = getHubOrThrow();
	return await hub.request<{
		rewindPoints: Array<{ uuid: string; timestamp: number; content: string; turnNumber: number }>;
		error?: string;
	}>('rewind.checkpoints', { sessionId });
}

export async function previewRewind(
	sessionId: string,
	checkpointId: string
): Promise<{ preview: import('@neokai/shared').RewindPreview }> {
	const hub = getHubOrThrow();
	return await hub.request<{ preview: import('@neokai/shared').RewindPreview }>('rewind.preview', {
		sessionId,
		checkpointId,
	});
}

export async function executeRewind(
	sessionId: string,
	checkpointId: string,
	mode: import('@neokai/shared').RewindMode = 'files'
): Promise<{ result: import('@neokai/shared').RewindResult }> {
	const hub = getHubOrThrow();
	return await hub.request<{ result: import('@neokai/shared').RewindResult }>('rewind.execute', {
		sessionId,
		checkpointId,
		mode,
	});
}

// ==================== Selective Rewind Operations ====================

export async function executeSelectiveRewind(
	sessionId: string,
	messageIds: string[],
	mode: import('@neokai/shared').RewindMode = 'both'
): Promise<{ result: import('@neokai/shared').SelectiveRewindResult }> {
	const hub = getHubOrThrow();
	return await hub.request<{ result: import('@neokai/shared').SelectiveRewindResult }>(
		'rewind.executeSelective',
		{ sessionId, messageIds, mode }
	);
}
