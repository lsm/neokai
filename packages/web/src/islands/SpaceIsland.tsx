/**
 * SpaceIsland — main content area for the Space view.
 * Rendered by MainContent when currentSpaceIdSignal is set.
 *
 * 3-column layout:
 * - Left (~240px): SpaceNavPanel — workflow runs, tasks, nav links
 * - Middle (flex-1): SpaceDashboard (default) or other detail views
 * - Right (~320px, conditional): SpaceTaskPane when a task is selected
 */

import { useState, useEffect } from 'preact/hooks';
import { spaceStore } from '../lib/space-store';
import { currentSpaceTaskIdSignal } from '../lib/signals';
import { navigateToSpaceTask, navigateToSpace } from '../lib/router';
import { SpaceNavPanel } from '../components/space/SpaceNavPanel';
import { SpaceDashboard } from '../components/space/SpaceDashboard';
import { SpaceTaskPane } from '../components/space/SpaceTaskPane';

interface SpaceIslandProps {
	spaceId: string;
}

export default function SpaceIsland({ spaceId }: SpaceIslandProps) {
	const [activeRunId, setActiveRunId] = useState<string | null>(null);
	const loading = spaceStore.loading.value;
	const error = spaceStore.error.value;

	// Derive active task ID from the global signal
	const activeTaskId = currentSpaceTaskIdSignal.value;

	// Load space data on mount or when spaceId changes
	useEffect(() => {
		spaceStore.selectSpace(spaceId).catch(() => {
			// Error is tracked in spaceStore.error
		});

		return () => {
			// Optionally clear when unmounting; leave it for now so
			// navigating back is instant (store shows stale-then-fresh data).
		};
	}, [spaceId]);

	const handleRunSelect = (runId: string) => {
		setActiveRunId(runId);
		// Clear task selection when switching to a run
		currentSpaceTaskIdSignal.value = null;
	};

	const handleTaskSelect = (taskId: string) => {
		setActiveRunId(null);
		navigateToSpaceTask(spaceId, taskId);
	};

	const handleTaskPaneClose = () => {
		navigateToSpace(spaceId);
	};

	if (loading && !spaceStore.space.value) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
					<p class="text-sm text-gray-500">Loading space...</p>
				</div>
			</div>
		);
	}

	if (error && !spaceStore.space.value) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center max-w-sm">
					<p class="text-sm text-red-400 mb-2">Failed to load space</p>
					<p class="text-xs text-gray-600">{error}</p>
				</div>
			</div>
		);
	}

	return (
		<div class="flex-1 flex overflow-hidden bg-dark-900">
			{/* Left column — navigation panel */}
			<div class="w-60 flex-shrink-0 border-r border-dark-700 overflow-hidden flex flex-col">
				<SpaceNavPanel
					spaceId={spaceId}
					activeTaskId={activeTaskId}
					activeRunId={activeRunId}
					onRunSelect={handleRunSelect}
					onTaskSelect={handleTaskSelect}
				/>
			</div>

			{/* Middle column — main content */}
			<div class="flex-1 overflow-hidden flex flex-col min-w-0">
				<SpaceDashboard spaceId={spaceId} />
			</div>

			{/* Right column — task detail pane (conditionally shown) */}
			{activeTaskId && (
				<div class="hidden md:flex w-80 flex-shrink-0 border-l border-dark-700 overflow-hidden flex-col">
					<SpaceTaskPane taskId={activeTaskId} onClose={handleTaskPaneClose} />
				</div>
			)}
		</div>
	);
}
