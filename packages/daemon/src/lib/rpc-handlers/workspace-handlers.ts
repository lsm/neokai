/**
 * Workspace History RPC Handlers
 *
 * Provides backend-persisted workspace path history for the session creation flow.
 * The frontend calls these instead of (or in addition to) localStorage.
 */

import type { MessageHub } from '@neokai/shared';
import type { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository';

export function setupWorkspaceHandlers(
	messageHub: MessageHub,
	workspaceHistoryRepo: WorkspaceHistoryRepository
): void {
	// Get workspace history
	messageHub.onRequest('workspace.history', async (_data) => {
		const rows = workspaceHistoryRepo.list(20);
		return {
			entries: rows.map((r) => ({
				path: r.path,
				lastUsedAt: r.last_used_at,
				useCount: r.use_count,
			})),
		};
	});

	// Add/update workspace in history
	messageHub.onRequest('workspace.add', async (data) => {
		const { path } = data as { path: string };
		if (!path || typeof path !== 'string') {
			throw new Error('path is required');
		}
		const row = workspaceHistoryRepo.upsert(path);
		return {
			entry: {
				path: row.path,
				lastUsedAt: row.last_used_at,
				useCount: row.use_count,
			},
		};
	});

	// Remove workspace from history
	messageHub.onRequest('workspace.remove', async (data) => {
		const { path } = data as { path: string };
		if (!path || typeof path !== 'string') {
			throw new Error('path is required');
		}
		const success = workspaceHistoryRepo.remove(path);
		return { success };
	});
}
