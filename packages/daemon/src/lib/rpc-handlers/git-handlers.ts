/**
 * Git RPC Handlers
 *
 * Read-only git context for folder paths, used by the session-creation flow to
 * drive workspace / worktree / branch pickers.
 */

import type { MessageHub } from '@neokai/shared';
import type { WorktreeManager } from '../worktree-manager';

export function setupGitHandlers(messageHub: MessageHub, worktreeManager: WorktreeManager): void {
	// Git context (repo detection, branches, current/default branch, dirty state)
	// for a folder path. Returns a safe empty result for non-git paths.
	messageHub.onRequest('git.branches', async (data) => {
		const { path } = (data ?? {}) as { path?: unknown };
		if (typeof path !== 'string' || path.trim().length === 0) {
			throw new Error('git.branches: "path" is required');
		}
		return worktreeManager.getRepoGitInfo(path.trim());
	});
}
