/**
 * SpaceIsland — main content area for the Space view.
 *
 * Content priority chain (full-width, each replaces the next):
 * 1. sessionViewId set → ChatContainer (agent/session chat)
 * 2. taskViewId set    → SpaceTaskPane (full-width task detail)
 * 3. default           → route-driven space view
 *
 * The default route renders the task-focused overview.
 * Configure lives at its own route and reuses the same shell/context panel.
 */

import { useEffect } from 'preact/hooks';
import type { SpaceViewMode } from '../lib/signals';
import { SpaceConfigurePage } from '../components/space/SpaceConfigurePage';
import { SpaceDashboard } from '../components/space/SpaceDashboard';
import { SpaceTaskPane } from '../components/space/SpaceTaskPane';
import { spaceStore } from '../lib/space-store';
import { navigateToSpace, navigateToSpaceAgent, navigateToSpaceTask } from '../lib/router';
import ChatContainer from './ChatContainer';

interface SpaceIslandProps {
	spaceId: string;
	viewMode: SpaceViewMode;
	sessionViewId?: string | null;
	taskViewId?: string | null;
}

export default function SpaceIsland({
	spaceId,
	viewMode,
	sessionViewId,
	taskViewId,
}: SpaceIslandProps) {
	const loading = spaceStore.loading.value;
	const error = spaceStore.error.value;
	const workflows = spaceStore.workflows.value;

	useEffect(() => {
		spaceStore.selectSpace(spaceId).catch(() => {
			// Error is tracked in spaceStore.error
		});
	}, [spaceId]);

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

	const space = spaceStore.space.value;

	if (sessionViewId) {
		return <ChatContainer key={sessionViewId} sessionId={sessionViewId} />;
	}

	if (taskViewId) {
		return (
			<div class="flex-1 flex flex-col overflow-hidden bg-dark-900" data-testid="space-task-pane">
				<SpaceTaskPane taskId={taskViewId} spaceId={spaceId} onClose={handleTaskPaneClose} />
			</div>
		);
	}

	if (viewMode === 'configure' && space) {
		return (
			<div class="flex-1 flex overflow-hidden bg-dark-900" data-testid="space-configure-view">
				<div class="flex-1 min-w-0 overflow-hidden flex flex-col">
					<SpaceConfigurePage space={space} workflows={workflows} />
				</div>
			</div>
		);
	}

	if (viewMode === 'configure' && !space) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<p class="text-sm text-gray-500">Space not found</p>
			</div>
		);
	}

	return (
		<div class="flex-1 flex overflow-hidden bg-dark-900" data-testid="space-overview-view">
			<div class="flex-1 min-w-0 overflow-hidden flex flex-col">
				<SpaceDashboard
					spaceId={spaceId}
					onOpenSpaceAgent={() => navigateToSpaceAgent(spaceId)}
					onSelectTask={(taskId) => navigateToSpaceTask(spaceId, taskId)}
				/>
			</div>
		</div>
	);
}
