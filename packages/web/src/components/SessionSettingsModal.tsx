/**
 * Session Settings Modal
 *
 * Per-session settings including MCP tool configuration.
 * This is the primary place to configure MCP tools for a specific session.
 */

import type { Session } from '@liuboer/shared';
import { Modal } from './ui/Modal.tsx';
import { McpToolsSettings } from './McpToolsSettings.tsx';
import { borderColors } from '../lib/design-tokens.ts';

interface SessionSettingsModalProps {
	isOpen: boolean;
	onClose: () => void;
	session: Session | null;
}

export function SessionSettingsModal({ isOpen, onClose, session }: SessionSettingsModalProps) {
	if (!session) return null;

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

				{/* MCP Tools Settings */}
				<McpToolsSettings />

				{/* Info note */}
				<div class="text-xs text-gray-500">
					<strong>Note:</strong> Changes to MCP tool permissions require a session restart to take
					effect. Use the "Restart Session Now" button above after making changes.
				</div>
			</div>
		</Modal>
	);
}
