/**
 * SpaceIsland — main content area for the Space view.
 *
 * Content priority chain (full-width, each replaces the next):
 * 1. sessionViewId set → ChatContainer (agent/session chat)
 * 2. taskViewId set    → SpaceTaskPane (full-width task detail)
 * 3. viewMode === 'configure' → SpaceConfigurePage (agents / workflows / settings)
 * 4. default           → tabbed view — Dashboard | Agents | Workflows | Settings
 *
 * Dashboard tab shows WorkflowCanvas:
 *   - Runtime mode when a workflow run exists (active or most-recent blocked)
 *   - Template mode when no runs but workflows exist (editable gates)
 *   - Falls back to SpaceDashboard when no workflows configured
 *   - On small screens the canvas is hidden; SpaceDashboard is shown instead
 *
 * Space navigation is handled by the Context Panel sidebar.
 */

import { useState, useEffect } from 'preact/hooks';
import type { SpaceViewMode } from '../lib/signals';
import { spaceOverlaySessionIdSignal } from '../lib/signals';
import { SpaceConfigurePage } from '../components/space/SpaceConfigurePage';
import { SpaceDashboard } from '../components/space/SpaceDashboard';
import { SpaceTaskPane } from '../components/space/SpaceTaskPane';
import { SpaceAgentList } from '../components/space/SpaceAgentList';
import { WorkflowList } from '../components/space/WorkflowList';
import { VisualWorkflowEditor } from '../components/space/visual-editor/VisualWorkflowEditor';
import { WorkflowCanvas } from '../components/space/WorkflowCanvas';
import { SpaceSettings } from '../components/space/SpaceSettings';
import { AgentOverlayChat } from '../components/space/AgentOverlayChat';
import { spaceStore } from '../lib/space-store';
import { navigateToSpace, navigateToSpaceAgent, navigateToSpaceTask } from '../lib/router';
import ChatContainer from './ChatContainer';
import { cn } from '../lib/utils';

interface SpaceIslandProps {
	spaceId: string;
	viewMode: SpaceViewMode;
	sessionViewId?: string | null;
	taskViewId?: string | null;
}

type SpaceTab = 'dashboard' | 'agents' | 'workflows' | 'settings';

const TABS: { id: SpaceTab; label: string }[] = [
	{ id: 'dashboard', label: 'Dashboard' },
	{ id: 'agents', label: 'Agents' },
	{ id: 'workflows', label: 'Workflows' },
	{ id: 'settings', label: 'Settings' },
];

export default function SpaceIsland({
	spaceId,
	viewMode,
	sessionViewId,
	taskViewId,
}: SpaceIslandProps) {
	const [activeTab, setActiveTab] = useState<SpaceTab>('dashboard');
	/** null = list view; 'new' = create editor; <id> = edit editor */
	const [workflowEditId, setWorkflowEditId] = useState<string | null>(null);

	// Overlay session — shown as a slide-over on top of the current view
	const overlaySessionId = spaceOverlaySessionIdSignal.value;
	const handleOverlayClose = () => {
		spaceOverlaySessionIdSignal.value = null;
	};

	const loading = spaceStore.loading.value;
	const error = spaceStore.error.value;
	const workflows = spaceStore.workflows.value;

	// Canvas mode: prefer an active run; fall back to the most-recent blocked/done run
	// so the canvas continues showing gate state after a run transitions to blocked.
	const activeRuns = spaceStore.activeRuns.value;
	const allRuns = spaceStore.workflowRuns.value;
	const activeRun = activeRuns[0] ?? null;
	const displayRun =
		activeRun ??
		(allRuns.length > 0
			? allRuns.reduce((latest, r) => (r.updatedAt > latest.updatedAt ? r : latest))
			: null);
	const defaultWorkflow = displayRun
		? (workflows.find((w) => w.id === displayRun.workflowId) ?? workflows[0] ?? null)
		: (workflows[0] ?? null);
	/** True when the canvas should be shown on the dashboard tab */
	const showCanvas = defaultWorkflow !== null;

	useEffect(() => {
		spaceStore.selectSpace(spaceId).catch(() => {
			// Error is tracked in spaceStore.error
		});
	}, [spaceId]);

	// Reset workflow edit state when switching away from workflows tab
	useEffect(() => {
		if (activeTab !== 'workflows') {
			setWorkflowEditId(null);
		}
	}, [activeTab]);

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
		return (
			<>
				<ChatContainer key={sessionViewId} sessionId={sessionViewId} />
				{overlaySessionId && (
					<AgentOverlayChat
						sessionId={overlaySessionId}
						agentName={overlaySessionId}
						onClose={handleOverlayClose}
					/>
				)}
			</>
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
						agentName={overlaySessionId}
						onClose={handleOverlayClose}
					/>
				)}
			</>
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

	const editingWorkflow =
		workflowEditId && workflowEditId !== 'new'
			? workflows.find((w) => w.id === workflowEditId)
			: undefined;

	const showWorkflowEditor = activeTab === 'workflows' && workflowEditId !== null;

	return (
		<>
			{overlaySessionId && (
				<AgentOverlayChat
					sessionId={overlaySessionId}
					agentName={overlaySessionId}
					onClose={handleOverlayClose}
				/>
			)}
			<div class="flex-1 flex overflow-hidden bg-dark-900" data-testid="space-overview-view">
				{/* Main content — tabbed view */}
				<div class="flex-1 overflow-hidden flex flex-col min-w-0">
					{/* Tab bar — hidden when workflow editor is open */}
					{!showWorkflowEditor && (
						<div
							class="flex border-b border-dark-700 px-4 flex-shrink-0"
							data-testid="space-tab-bar"
						>
							{TABS.map((tab) => (
								<button
									key={tab.id}
									type="button"
									onClick={() => setActiveTab(tab.id)}
									class={cn(
										'px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px',
										activeTab === tab.id
											? 'text-gray-100 border-blue-400'
											: 'text-gray-400 border-transparent hover:text-gray-200'
									)}
								>
									{tab.label}
								</button>
							))}
						</div>
					)}

					{/* Tab content */}
					<div class="flex-1 overflow-hidden">
						{showWorkflowEditor ? (
							<VisualWorkflowEditor
								key={workflowEditId}
								workflow={editingWorkflow}
								onSave={() => setWorkflowEditId(null)}
								onCancel={() => setWorkflowEditId(null)}
							/>
						) : (
							<>
								{activeTab === 'dashboard' && (
									<>
										{/* Canvas panel — shown on md+ when a workflow or run exists */}
										{showCanvas && (
											<div
												class="hidden md:flex flex-col h-full overflow-hidden"
												data-testid="canvas-panel"
											>
												{/* Active-run banner */}
												{displayRun && (
													<div class="flex items-center gap-2 px-4 py-2 border-b border-dark-700 bg-dark-900 flex-shrink-0">
														<span
															class={cn(
																'w-2 h-2 rounded-full flex-shrink-0',
																activeRun ? 'bg-blue-400 animate-pulse' : 'bg-amber-400'
															)}
														/>
														<span class="text-xs text-blue-300 truncate">{displayRun.title}</span>
														<span class="ml-auto text-xs text-gray-600 capitalize flex-shrink-0">
															{displayRun.status.replace('_', ' ')}
														</span>
													</div>
												)}
												<WorkflowCanvas
													key={`${defaultWorkflow.id}:${displayRun?.id ?? 'template'}`}
													workflowId={defaultWorkflow.id}
													runId={displayRun?.id ?? null}
													spaceId={spaceId}
													class="flex-1 min-h-0"
												/>
											</div>
										)}
										{/* Fallback: shown on mobile, or when no canvas data */}
										<div
											class={cn('flex flex-col h-full overflow-y-auto', showCanvas && 'md:hidden')}
											data-testid="dashboard-fallback"
										>
											<SpaceDashboard
												spaceId={spaceId}
												onOpenSpaceAgent={() => navigateToSpaceAgent(spaceId)}
												onSelectTask={(taskId) => navigateToSpaceTask(spaceId, taskId)}
											/>
										</div>
									</>
								)}
								{activeTab === 'agents' && (
									<div class="p-6 h-full overflow-y-auto">
										<SpaceAgentList />
									</div>
								)}
								{activeTab === 'workflows' && space && (
									<WorkflowList
										spaceId={spaceId}
										spaceName={space.name}
										workflows={workflows}
										onCreateWorkflow={() => setWorkflowEditId('new')}
										onEditWorkflow={(id) => setWorkflowEditId(id)}
									/>
								)}
								{activeTab === 'settings' && space && <SpaceSettings space={space} />}
							</>
						)}
					</div>
				</div>
			</div>
		</>
	);
}
