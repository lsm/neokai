/**
 * Session Settings Modal
 *
 * Per-session settings including MCP tool configuration.
 * This is the primary place to configure MCP tools for a specific session.
 */

import { useState } from 'preact/hooks';
import type { Session } from '@liuboer/shared';
import type { ArchiveSessionResponse } from '@liuboer/shared';
import { Modal } from './ui/Modal.tsx';
import { McpToolsSettings } from './McpToolsSettings.tsx';
import { borderColors } from '../lib/design-tokens.ts';
import { archiveSession } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import { cn } from '../lib/utils.ts';

interface SessionSettingsModalProps {
	isOpen: boolean;
	onClose: () => void;
	session: Session | null;
}

export function SessionSettingsModal({ isOpen, onClose, session }: SessionSettingsModalProps) {
	const [archiving, setArchiving] = useState(false);
	const [confirmDialog, setConfirmDialog] = useState<{
		show: boolean;
		commitStatus?: ArchiveSessionResponse['commitStatus'];
	} | null>(null);

	if (!session) return null;

	const handleArchiveClick = async () => {
		try {
			setArchiving(true);
			const result = await archiveSession(session.id, false);

			if (result.requiresConfirmation && result.commitStatus) {
				setConfirmDialog({ show: true, commitStatus: result.commitStatus });
			} else if (result.success) {
				toast.success('Session archived successfully');
				onClose();
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to archive session');
		} finally {
			setArchiving(false);
		}
	};

	const handleConfirmArchive = async () => {
		try {
			setArchiving(true);
			const result = await archiveSession(session.id, true);

			if (result.success) {
				toast.success(`Session archived (${result.commitsRemoved} commits removed)`);
				setConfirmDialog(null);
				onClose();
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to archive session');
		} finally {
			setArchiving(false);
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={onClose} title="Session Settings" size="lg">
			<div class="space-y-6">
				{/* Session Info */}
				<div class={`bg-dark-800 rounded-lg p-4 border ${borderColors.ui.secondary}`}>
					<h3 class="text-sm font-medium text-gray-300 mb-3">Session Information</h3>
					<div class="space-y-2 text-sm">
						<div class="flex justify-between">
							<span class="text-gray-400">Title</span>
							<span class="text-gray-200">{session.title}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-gray-400">Model</span>
							<span class="text-gray-200 font-mono text-xs">{session.config.model}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-gray-400">Workspace</span>
							<span
								class="text-gray-200 font-mono text-xs truncate max-w-[200px]"
								title={session.workspacePath}
							>
								{session.workspacePath.split('/').slice(-2).join('/')}
							</span>
						</div>
						{session.worktree && (
							<div class="flex justify-between">
								<span class="text-gray-400">Git Branch</span>
								<span class="text-gray-200 font-mono text-xs">{session.worktree.branch}</span>
							</div>
						)}
						<div class="flex justify-between">
							<span class="text-gray-400">Created</span>
							<span class="text-gray-200">{new Date(session.createdAt).toLocaleString()}</span>
						</div>
					</div>
				</div>

				{/* Archive Session Section */}
				<div class="space-y-2">
					<h3 class="text-sm font-medium text-gray-200">Archive Session</h3>
					<p class="text-xs text-gray-400">
						Archive this session to clean up worktree and mark as read-only.
					</p>
					<button
						onClick={handleArchiveClick}
						disabled={archiving || session.status === 'archived'}
						class={cn(
							'w-full px-4 py-2 rounded-lg transition-colors',
							'bg-orange-500/10 text-orange-400 border border-orange-500/20',
							'hover:bg-orange-500/20 disabled:opacity-50 disabled:cursor-not-allowed',
							'flex items-center justify-center gap-2'
						)}
					>
						{archiving ? (
							<>
								<div class="w-4 h-4 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
								<span>Archiving...</span>
							</>
						) : session.status === 'archived' ? (
							<span>Already archived</span>
						) : (
							<>
								<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
									/>
								</svg>
								<span>Archive Session</span>
							</>
						)}
					</button>
				</div>

				{/* MCP Tools Settings */}
				<McpToolsSettings />

				{/* Info note */}
				<div class="text-xs text-gray-500">
					<strong>Note:</strong> Changes to MCP tool permissions require a session restart to take
					effect. Use the "Restart Session Now" button above after making changes.
				</div>
			</div>

			{/* Confirmation Dialog for commits */}
			{confirmDialog?.show && confirmDialog.commitStatus && (
				<div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
					<div class="bg-dark-800 border border-dark-600 rounded-xl p-6 max-w-md mx-4">
						<h3 class="text-lg font-semibold text-gray-100 mb-3">Confirm Archive</h3>
						<p class="text-sm text-gray-300 mb-4">
							This worktree has {confirmDialog.commitStatus.commits.length} uncommitted changes:
						</p>
						<div class="bg-dark-900 rounded-lg p-3 mb-4 max-h-48 overflow-y-auto">
							{confirmDialog.commitStatus.commits.map((commit) => (
								<div key={commit.hash} class="mb-2 text-xs">
									<div class="font-mono text-blue-400">{commit.hash}</div>
									<div class="text-gray-300">{commit.message}</div>
									<div class="text-gray-500">
										{commit.author} • {commit.date}
									</div>
								</div>
							))}
						</div>
						<p class="text-sm text-orange-400 mb-4">
							These commits will be lost when the worktree is removed. Continue?
						</p>
						<div class="flex gap-3">
							<button
								onClick={() => setConfirmDialog(null)}
								class="flex-1 px-4 py-2 bg-dark-700 text-gray-300 rounded-lg hover:bg-dark-600 transition-colors"
							>
								Cancel
							</button>
							<button
								onClick={handleConfirmArchive}
								disabled={archiving}
								class="flex-1 px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 transition-colors"
							>
								{archiving ? 'Archiving...' : 'Archive Anyway'}
							</button>
						</div>
					</div>
				</div>
			)}
		</Modal>
	);
}
