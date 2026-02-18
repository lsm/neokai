/**
 * ContextVersionHistory - Shows version history for room context
 *
 * Displays a list of context versions with:
 * - Version number and timestamp
 * - Who made the change
 * - View and rollback actions
 * - Current version indicator
 */

import { useState } from 'preact/hooks';
import type { RoomContextVersion } from '@neokai/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { ContextVersionViewer } from './ContextVersionViewer';

export interface ContextVersionHistoryProps {
	/** Room ID */
	roomId: string;
	/** Current active version number */
	currentVersion: number;
	/** List of available versions (should be sorted newest first) */
	versions: RoomContextVersion[];
	/** Handler for rolling back to a specific version */
	onRollback: (version: number) => Promise<void>;
	/** Handler for viewing a version's content */
	onViewVersion: (version: RoomContextVersion) => void;
	/** Whether the component is in a loading state */
	isLoading?: boolean;
}

// Format timestamp to relative or absolute time
function formatTimestamp(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;

	const minutes = Math.floor(diff / 60000);
	const hours = Math.floor(diff / 3600000);
	const days = Math.floor(diff / 86400000);

	if (minutes < 1) return 'Just now';
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;

	// For older dates, show the actual date
	const date = new Date(timestamp);
	return date.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
	});
}

// Changed by badge component
function ChangedByBadge({ changedBy }: { changedBy: 'human' | 'agent' }) {
	const isHuman = changedBy === 'human';
	return (
		<span
			class={cn(
				'px-1.5 py-0.5 text-xs font-medium rounded capitalize',
				isHuman ? 'bg-blue-900/50 text-blue-300' : 'bg-purple-900/50 text-purple-300'
			)}
		>
			{isHuman ? 'You' : 'Agent'}
		</span>
	);
}

// Version item component
interface VersionItemProps {
	version: RoomContextVersion;
	isCurrent: boolean;
	onView: () => void;
	onRollback: () => void;
	isLoading: boolean;
}

function VersionItem({ version, isCurrent, onView, onRollback, isLoading }: VersionItemProps) {
	const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);

	const handleRollback = async () => {
		await onRollback();
		setShowRollbackConfirm(false);
	};

	return (
		<>
			<div
				class={cn(
					'p-3 rounded-lg border transition-colors',
					isCurrent
						? 'bg-blue-900/20 border-blue-700/50'
						: 'bg-dark-850 border-dark-700 hover:border-dark-600'
				)}
			>
				{/* Version header */}
				<div class="flex items-center justify-between mb-2">
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium text-gray-200">v{version.version}</span>
						{isCurrent && (
							<span class="px-1.5 py-0.5 text-xs font-medium bg-green-900/50 text-green-300 rounded">
								Current
							</span>
						)}
					</div>
					<ChangedByBadge changedBy={version.changedBy} />
				</div>

				{/* Timestamp */}
				<p class="text-xs text-gray-500 mb-3">{formatTimestamp(version.createdAt)}</p>

				{/* Change reason if available */}
				{version.changeReason && (
					<p class="text-xs text-gray-400 mb-3 line-clamp-2">{version.changeReason}</p>
				)}

				{/* Actions */}
				<div class="flex items-center gap-2">
					<Button variant="ghost" size="sm" onClick={onView} disabled={isLoading}>
						<svg class="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
							/>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
							/>
						</svg>
						View
					</Button>
					{!isCurrent && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setShowRollbackConfirm(true)}
							disabled={isLoading}
						>
							<svg class="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
								/>
							</svg>
							Rollback
						</Button>
					)}
				</div>
			</div>

			{/* Rollback confirmation */}
			<ConfirmModal
				isOpen={showRollbackConfirm}
				onClose={() => setShowRollbackConfirm(false)}
				onConfirm={handleRollback}
				title="Rollback Context"
				message={`Are you sure you want to rollback to version ${version.version}? This will replace the current context with the content from this version.`}
				confirmText="Rollback"
				confirmButtonVariant="primary"
				isLoading={isLoading}
			/>
		</>
	);
}

// Empty state
function EmptyState() {
	return (
		<div class="p-4 text-center">
			<div class="w-10 h-10 rounded-full bg-dark-700 flex items-center justify-center mx-auto mb-3">
				<svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
			</div>
			<p class="text-sm text-gray-400">No version history yet</p>
			<p class="text-xs text-gray-500 mt-1">Versions will appear when you save context changes</p>
		</div>
	);
}

// Loading skeleton
function VersionSkeleton() {
	return (
		<div class="space-y-3">
			{[1, 2, 3].map((i) => (
				<div key={i} class="p-3 rounded-lg border border-dark-700 bg-dark-850">
					<div class="flex items-center justify-between mb-2">
						<div class="h-4 w-12 bg-dark-700 rounded animate-pulse" />
						<div class="h-4 w-16 bg-dark-700 rounded animate-pulse" />
					</div>
					<div class="h-3 w-24 bg-dark-700 rounded animate-pulse" />
				</div>
			))}
		</div>
	);
}

export function ContextVersionHistory({
	roomId: _roomId,
	currentVersion,
	versions,
	onRollback,
	onViewVersion,
	isLoading = false,
}: ContextVersionHistoryProps) {
	const [viewingVersion, setViewingVersion] = useState<RoomContextVersion | null>(null);

	// Sort versions by version number (newest first)
	const sortedVersions = [...versions].sort((a, b) => b.version - a.version);

	const handleView = (version: RoomContextVersion) => {
		setViewingVersion(version);
		onViewVersion(version);
	};

	const handleRollback = async (version: number) => {
		await onRollback(version);
	};

	return (
		<div class="h-full flex flex-col">
			{/* Header */}
			<div class="flex items-center justify-between mb-4">
				<h3 class="text-sm font-medium text-gray-300">Version History</h3>
				<span class="text-xs text-gray-500">
					{versions.length} version{versions.length !== 1 ? 's' : ''}
				</span>
			</div>

			{/* Version list */}
			<div class="flex-1 overflow-y-auto">
				{isLoading ? (
					<VersionSkeleton />
				) : versions.length === 0 ? (
					<EmptyState />
				) : (
					<div class="space-y-3">
						{sortedVersions.map((version) => (
							<VersionItem
								key={version.id}
								version={version}
								isCurrent={version.version === currentVersion}
								onView={() => handleView(version)}
								onRollback={() => handleRollback(version.version)}
								isLoading={isLoading}
							/>
						))}
					</div>
				)}
			</div>

			{/* Version viewer modal */}
			{viewingVersion && (
				<ContextVersionViewer
					version={viewingVersion}
					onClose={() => setViewingVersion(null)}
					onRollback={
						viewingVersion.version !== currentVersion
							? async () => {
									await handleRollback(viewingVersion.version);
									setViewingVersion(null);
								}
							: undefined
					}
				/>
			)}
		</div>
	);
}
