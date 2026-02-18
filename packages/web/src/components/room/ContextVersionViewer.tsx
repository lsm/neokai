/**
 * ContextVersionViewer - Modal to view a specific context version
 *
 * Displays the full content of a context version in a modal overlay:
 * - Version metadata (number, date, changed by)
 * - Background and instructions content (read-only)
 * - Close and optional rollback buttons
 */

import type { RoomContextVersion } from '@neokai/shared';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';

export interface ContextVersionViewerProps {
	/** Version to display */
	version: RoomContextVersion;
	/** Handler for closing the viewer */
	onClose: () => void;
	/** Optional handler for rolling back to this version */
	onRollback?: () => Promise<void>;
}

// Format date for display
function formatDate(timestamp: number): string {
	const date = new Date(timestamp);
	return date.toLocaleString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

// Content section component
function ContentSection({
	title,
	content,
	emptyText,
}: {
	title: string;
	content?: string;
	emptyText: string;
}) {
	return (
		<div>
			<h4 class="text-sm font-medium text-gray-300 mb-2">{title}</h4>
			<div
				class={cn(
					'px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg',
					'text-sm whitespace-pre-wrap break-words',
					content ? 'text-gray-200' : 'text-gray-500 italic'
				)}
			>
				{content || emptyText}
			</div>
		</div>
	);
}

export function ContextVersionViewer({ version, onClose, onRollback }: ContextVersionViewerProps) {
	const isChangedByHuman = version.changedBy === 'human';

	return (
		<Modal isOpen={true} onClose={onClose} title={`Version ${version.version}`} size="lg">
			<div class="space-y-4">
				{/* Metadata */}
				<div class="flex flex-wrap items-center gap-3 pb-4 border-b border-dark-700">
					{/* Version number */}
					<div class="flex items-center gap-2">
						<span class="text-sm text-gray-400">Version:</span>
						<span class="px-2 py-0.5 text-sm font-medium bg-dark-700 text-gray-200 rounded">
							v{version.version}
						</span>
					</div>

					{/* Changed by */}
					<div class="flex items-center gap-2">
						<span class="text-sm text-gray-400">Changed by:</span>
						<span
							class={cn(
								'px-2 py-0.5 text-sm font-medium rounded capitalize',
								isChangedByHuman
									? 'bg-blue-900/50 text-blue-300'
									: 'bg-purple-900/50 text-purple-300'
							)}
						>
							{isChangedByHuman ? 'You' : 'Agent'}
						</span>
					</div>

					{/* Date */}
					<div class="flex items-center gap-2">
						<span class="text-sm text-gray-400">Date:</span>
						<span class="text-sm text-gray-300">{formatDate(version.createdAt)}</span>
					</div>
				</div>

				{/* Change reason if available */}
				{version.changeReason && (
					<div>
						<h4 class="text-sm font-medium text-gray-300 mb-2">Change Reason</h4>
						<p class="text-sm text-gray-400 italic">{version.changeReason}</p>
					</div>
				)}

				{/* Background content */}
				<ContentSection
					title="Background"
					content={version.background}
					emptyText="No background content"
				/>

				{/* Instructions content */}
				<ContentSection
					title="Instructions"
					content={version.instructions}
					emptyText="No instructions content"
				/>

				{/* Actions */}
				<div class="flex items-center justify-between pt-4 border-t border-dark-700">
					<div>
						{onRollback && (
							<Button variant="secondary" onClick={onRollback}>
								<svg class="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
									/>
								</svg>
								Rollback to this version
							</Button>
						)}
					</div>
					<Button variant="ghost" onClick={onClose}>
						Close
					</Button>
				</div>
			</div>
		</Modal>
	);
}
