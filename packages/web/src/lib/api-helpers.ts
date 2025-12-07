/**
 * API Helper Functions
 *
 * Typed convenience functions for common daemon operations.
 * These wrap MessageHub.call() with type safety and better DX.
 */

import type {
	CreateSessionRequest,
	CreateSessionResponse,
	GetSessionResponse,
	ListSessionsResponse,
	UpdateSessionRequest,
	ListMessagesResponse,
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

// ==================== Session Operations ====================

export async function createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
	const hub = await connectionManager.getHub();
	return await hub.call<CreateSessionResponse>('session.create', req, {
		timeout: 15000,
	});
}

export async function listSessions(): Promise<ListSessionsResponse> {
	const hub = await connectionManager.getHub();
	return await hub.call<ListSessionsResponse>('session.list');
}

export async function getSession(sessionId: string): Promise<GetSessionResponse> {
	const hub = await connectionManager.getHub();
	return await hub.call<GetSessionResponse>('session.get', { sessionId });
}

export async function updateSession(sessionId: string, req: UpdateSessionRequest): Promise<void> {
	const hub = await connectionManager.getHub();
	await hub.call('session.update', { sessionId, ...req });
}

export async function deleteSession(sessionId: string): Promise<void> {
	const hub = await connectionManager.getHub();
	await hub.call('session.delete', { sessionId });
}

// ==================== Message Operations ====================

export async function listMessages(
	sessionId: string,
	params?: {
		limit?: number;
		offset?: number;
		before?: string;
		after?: string;
	}
): Promise<ListMessagesResponse> {
	const hub = await connectionManager.getHub();
	return await hub.call<ListMessagesResponse>('message.list', {
		sessionId,
		...params,
	});
}

export async function getSDKMessages(
	sessionId: string,
	params?: {
		limit?: number;
		offset?: number;
		since?: number;
	}
): Promise<{ sdkMessages: any[] }> {
	const hub = await connectionManager.getHub();
	return await hub.call<{ sdkMessages: any[] }>('message.sdkMessages', {
		sessionId,
		...params,
	});
}

// ==================== Command Operations ====================

export async function getSlashCommands(sessionId: string): Promise<{ commands: string[] }> {
	const hub = await connectionManager.getHub();
	return await hub.call<{ commands: string[] }>('commands.list', { sessionId });
}

// ==================== File Operations ====================

export async function readFile(sessionId: string, req: ReadFileRequest): Promise<ReadFileResponse> {
	const hub = await connectionManager.getHub();
	return await hub.call<ReadFileResponse>('file.read', {
		sessionId,
		...req,
	});
}

export async function listFiles(
	sessionId: string,
	req: ListFilesRequest
): Promise<ListFilesResponse> {
	const hub = await connectionManager.getHub();
	return await hub.call<ListFilesResponse>('file.list', {
		sessionId,
		...req,
	});
}

export async function getFileTree(
	sessionId: string,
	req: GetFileTreeRequest
): Promise<GetFileTreeResponse> {
	const hub = await connectionManager.getHub();
	return await hub.call<GetFileTreeResponse>('file.tree', {
		sessionId,
		...req,
	});
}

// ==================== System Operations ====================

export async function health(): Promise<HealthStatus> {
	const hub = await connectionManager.getHub();
	return await hub.call<HealthStatus>('system.health');
}

export async function getConfig(): Promise<DaemonConfig> {
	const hub = await connectionManager.getHub();
	return await hub.call<DaemonConfig>('system.config');
}

// ==================== Authentication ====================

export async function getAuthStatus(): Promise<GetAuthStatusResponse> {
	const hub = await connectionManager.getHub();
	return await hub.call<GetAuthStatusResponse>('auth.status');
}
