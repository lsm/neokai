/**
 * File RPC Handlers
 */

import type { MessageHub } from '@neokai/shared';
import type { SessionManager } from '../session-manager';
import type { ReadFileRequest, ListFilesRequest, GetFileTreeRequest } from '@neokai/shared';
import { FileManager } from '../file-manager';

export function setupFileHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
	messageHub.handle('file.read', async (data) => {
		const {
			sessionId: targetSessionId,
			path,
			encoding,
		} = data as ReadFileRequest & { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const fileManager = new FileManager(agentSession.getSessionData().workspacePath);
		const fileData = await fileManager.readFile(path, encoding as 'utf-8' | 'base64');

		return fileData;
	});

	messageHub.handle('file.list', async (data) => {
		const {
			sessionId: targetSessionId,
			path,
			recursive,
		} = data as ListFilesRequest & { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const fileManager = new FileManager(agentSession.getSessionData().workspacePath);
		const files = await fileManager.listDirectory(path || '.', recursive);

		return { files };
	});

	messageHub.handle('file.tree', async (data) => {
		const {
			sessionId: targetSessionId,
			path,
			maxDepth,
		} = data as GetFileTreeRequest & { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const fileManager = new FileManager(agentSession.getSessionData().workspacePath);
		const tree = await fileManager.getFileTree(path || '.', maxDepth || 3);

		return { tree };
	});
}
