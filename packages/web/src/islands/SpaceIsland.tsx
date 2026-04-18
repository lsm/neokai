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

import { useCallback, useEffect } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import type { SpaceViewMode } from '../lib/signals';
import { spaceOverlaySessionIdSignal, spaceOverlayAgentNameSignal } from '../lib/signals';
import { SpacePageHeader } from '../components/space/SpacePageHeader';
import { AgentOverlayChat } from '../components/space/AgentOverlayChat';
import { spaceStore } from '../lib/space-store';
import { navigateToSpace, navigateToSpaceTask } from '../lib/router';
import ChatContainer from './ChatContainer';

const SpaceConfigurePage = lazy(() =>
	import('../components/space/SpaceConfigurePage').then((m) => ({ default: m.SpaceConfigurePage }))
);
const SpaceSessionsPage = lazy(() =>
	import('../components/space/SpaceSessionsPage').then((m) => ({ default: m.SpaceSessionsPage }))
);
const SpaceTasks = lazy(() =>
	import('../components/space/SpaceTasks').then((m) => ({ default: m.SpaceTasks }))
);
const SpaceOverview = lazy(() =>
	import('../components/space/SpaceOverview').then((m) => ({ default: m.SpaceOverview }))
);
const SpaceTaskPane = lazy(() =>
	import('../components/space/SpaceTaskPane').then((m) => ({ default: m.SpaceTaskPane }))
);

/** Shared Suspense fallback for lazy-loaded space views. */
const lazyFallback = (
	<div class="flex-1 flex items-center justify-center bg-dark-900">
		<div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
	</div>
);

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
	const handleOverlayClose = useCallback(() => {
		spaceOverlaySessionIdSignal.value = null;
		spaceOverlayAgentNameSignal.value = null;
	}, []);

	// Test hook: expose overlay controls on window.__neokai_space_overlay so E2E
	// tests can trigger the overlay programmatically. Opening is purely
	// client-side signal manipulation — no security concern in exposing this.
	useEffect(() => {
		type OverlayApi = { open: (sessionId: string, agentName?: string) => void; close: () => void };
		const w = window as typeof window & { __neokai_space_overlay?: OverlayApi };
		w.__neokai_space_overlay = {
			open(sessionId, agentName) {
				spaceOverlayAgentNameSignal.value = agentName ?? null;
				spaceOverlaySessionIdSignal.value = sessionId;
			},
			close() {
				spaceOverlaySessionIdSignal.value = null;
				spaceOverlayAgentNameSignal.value = null;
			},
		};
		return () => {
			w.__neokai_space_overlay = undefined;
		};
	}, []);

	const error = spaceStore.error.value;

	useEffect(() => {
		spaceStore.selectSpace(spaceId).catch(() => {
			// Error is tracked in spaceStore.error
		});
	}, [spaceId]);

	const handleTaskPaneClose = useCallback(() => {
		navigateToSpace(spaceId);
	}, [spaceId]);

	// Session/agent chat view — render immediately, don't block on space data
	// ChatContainer's root is already flex-1 flex-col overflow-hidden.
	// AgentOverlayChat uses a Portal so it doesn't affect layout.
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

	// For non-session views, show spinner/error while space data loads.
	// Show spinner if space is not yet loaded and there's no error — this covers
	// both the initial render (loading=false, space=null) before the useEffect has
	// called selectSpace and the active-loading state (loading=true, space=null).
	const space = spaceStore.space.value;
	if (!space && !error) {
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
					<Suspense fallback={lazyFallback}>
						<SpaceTaskPane taskId={taskViewId} spaceId={spaceId} onClose={handleTaskPaneClose} />
					</Suspense>
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
				<div
					class="flex-1 flex flex-col overflow-hidden bg-dark-900"
					data-testid="space-tasks-view"
				>
					<SpacePageHeader spaceName={space.name} pageTitle="Tasks" />
					<div class="flex-1 min-w-0 overflow-hidden flex flex-col">
						<Suspense fallback={lazyFallback}>
							<SpaceTasks
								spaceId={spaceId}
								onSelectTask={(taskId) => navigateToSpaceTask(spaceId, taskId)}
							/>
						</Suspense>
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

	if (viewMode === 'sessions' && space) {
		return (
			<>
				<div
					class="flex-1 flex flex-col overflow-hidden bg-dark-900"
					data-testid="space-sessions-view"
				>
					<SpacePageHeader spaceName={space.name} pageTitle="Sessions" />
					<div class="flex-1 min-w-0 overflow-hidden flex flex-col">
						<Suspense fallback={lazyFallback}>
							<SpaceSessionsPage spaceId={spaceId} />
						</Suspense>
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
				<div
					class="flex-1 flex flex-col overflow-hidden bg-dark-900"
					data-testid="space-configure-view"
				>
					<SpacePageHeader spaceName={space.name} pageTitle="Settings" />
					<div class="flex-1 min-w-0 overflow-hidden flex flex-col">
						<Suspense fallback={lazyFallback}>
							<SpaceConfigurePage space={space} />
						</Suspense>
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

	return (
		<>
			{overlaySessionId && (
				<AgentOverlayChat
					sessionId={overlaySessionId}
					agentName={overlayAgentName ?? undefined}
					onClose={handleOverlayClose}
				/>
			)}
			<div
				class="flex-1 flex flex-col overflow-hidden bg-dark-900"
				data-testid="space-overview-view"
			>
				<SpacePageHeader spaceName={space?.name ?? ''} pageTitle="Overview" />
				<div class="flex-1 overflow-hidden flex flex-col min-w-0">
					<Suspense fallback={lazyFallback}>
						<SpaceOverview
							spaceId={spaceId}
							onSelectTask={(taskId) => navigateToSpaceTask(spaceId, taskId)}
						/>
					</Suspense>
				</div>
			</div>
		</>
	);
}
