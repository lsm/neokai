/**
 * SpaceIsland — main content area for the Space view.
 *
 * Content priority chain (full-width, each replaces the next):
 * 1. sessionViewId set → ChatContainer (agent/session chat)
 * 2. taskViewId set    → SpaceTaskPane (full-width task detail)
 * 3. viewMode === 'configure' → SpaceConfigurePage (agents / workflows / settings)
 * 4. default           → overview surface (space task list/dashboard)
 *
 * Space navigation is handled by the Context Panel sidebar.
 */

import { useEffect } from 'preact/hooks';
import type { SpaceViewMode } from '../lib/signals';
import { spaceOverlaySessionIdSignal, spaceOverlayAgentNameSignal } from '../lib/signals';
import { SpaceConfigurePage } from '../components/space/SpaceConfigurePage';
import { SpaceTasks } from '../components/space/SpaceTasks';
import { SpaceDashboard } from '../components/space/SpaceDashboard';
import { SpaceTaskPane } from '../components/space/SpaceTaskPane';
import { AgentOverlayChat } from '../components/space/AgentOverlayChat';
import { spaceStore } from '../lib/space-store';
import { navigateToSpace, navigateToSpaceTask } from '../lib/router';
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
	// Overlay session — shown as a slide-over on top of the current view
	const overlaySessionId = spaceOverlaySessionIdSignal.value;
	const overlayAgentName = spaceOverlayAgentNameSignal.value;
	const handleOverlayClose = () => {
		spaceOverlaySessionIdSignal.value = null;
		spaceOverlayAgentNameSignal.value = null;
	};

	const loading = spaceStore.loading.value;
	const error = spaceStore.error.value;

	useEffect(() => {
		spaceStore.selectSpace(spaceId).catch(() => {
			// Error is tracked in spaceStore.error
		});
	}, [spaceId]);

	const handleTaskPaneClose = () => {
		navigateToSpace(spaceId);
	};

	// Session/agent chat view — render immediately, don't block on space data
	if (sessionViewId) {
		return (
			<>
				<ChatContainer key={sessionViewId} sessionId={sessionViewId} />
				{overlaySessionId && (
					<AgentOverlayChat
						sessionId={overlaySessionId}
						agentName={overlayAgentName ?? undefined}
						onClose={handleOverlayClose}
					/>
				)}
			</>
		);
	}

	// For non-session views, show spinner/error while space data loads
	const space = spaceStore.space.value;
	if (!space && loading) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
			</div>
		);
	}
	if (!space && error) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center max-w-sm">
					<p class="text-sm text-red-400 mb-2">Failed to load space</p>
					<p class="text-xs text-gray-600">{error}</p>
				</div>
			</div>
		);
	}

	if (taskViewId) {
		return (
			<>
				<div class="flex-1 flex flex-col overflow-hidden bg-dark-900" data-testid="space-task-pane">
					<SpaceTaskPane taskId={taskViewId} spaceId={spaceId} onClose={handleTaskPaneClose} />
				</div>
				{overlaySessionId && (
					<AgentOverlayChat
						sessionId={overlaySessionId}
						agentName={overlayAgentName ?? undefined}
						onClose={handleOverlayClose}
					/>
				)}
			</>
		);
	}

	if (viewMode === 'tasks' && space) {
		return (
			<>
				<div class="flex-1 flex overflow-hidden bg-dark-900" data-testid="space-tasks-view">
					<div class="flex-1 min-w-0 overflow-hidden flex flex-col">
						<SpaceTasks
							spaceId={spaceId}
							onSelectTask={(taskId) => navigateToSpaceTask(spaceId, taskId)}
						/>
					</div>
				</div>
				{overlaySessionId && (
					<AgentOverlayChat
						sessionId={overlaySessionId}
						agentName={overlayAgentName ?? undefined}
						onClose={handleOverlayClose}
					/>
				)}
			</>
		);
	}

	if (viewMode === 'configure' && space) {
		return (
			<>
				<div class="flex-1 flex overflow-hidden bg-dark-900" data-testid="space-configure-view">
					<div class="flex-1 min-w-0 overflow-hidden flex flex-col">
						<SpaceConfigurePage space={space} />
					</div>
				</div>
				{overlaySessionId && (
					<AgentOverlayChat
						sessionId={overlaySessionId}
						agentName={overlayAgentName ?? undefined}
						onClose={handleOverlayClose}
					/>
				)}
			</>
		);
	}

	if (viewMode === 'configure' && !space) {
		return (
			<>
				<div class="flex-1 flex items-center justify-center bg-dark-900">
					<p class="text-sm text-gray-500">Space not found</p>
				</div>
				{overlaySessionId && (
					<AgentOverlayChat
						sessionId={overlaySessionId}
						agentName={overlayAgentName ?? undefined}
						onClose={handleOverlayClose}
					/>
				)}
			</>
		);
	}

	return (
		<>
			{overlaySessionId && (
				<AgentOverlayChat
					sessionId={overlaySessionId}
					agentName={overlayAgentName ?? undefined}
					onClose={handleOverlayClose}
				/>
			)}
			<div class="flex-1 flex overflow-hidden bg-dark-900" data-testid="space-overview-view">
				<div class="flex-1 overflow-hidden flex flex-col min-w-0">
					<SpaceDashboard
						spaceId={spaceId}
						onSelectTask={(taskId) => navigateToSpaceTask(spaceId, taskId)}
					/>
				</div>
			</div>
		</>
	);
}
