/**
 * SpaceIsland — main content area for the Space view.
 *
 * Content priority chain (full-width, each replaces the next):
 * 1. sessionViewId set → ChatContainer (agent/session chat)
 * 2. taskViewId set    → SpaceTaskPane (full-width task detail)
 * 3. default          → tabbed view — Dashboard | Agents | Workflows | Settings
 *
 * Dashboard tab shows WorkflowCanvas:
 *   - Runtime mode when an active workflow run exists (read-only, live status)
 *   - Template mode when no active run but workflows exist
 *   - Falls back to SpaceDashboard when no workflows configured
 *   - On small screens the canvas is hidden; SpaceDashboard is shown instead
 *
 * Space navigation is handled by the Context Panel sidebar.
 */

import { useState, useEffect } from 'preact/hooks';
import { spaceStore } from '../lib/space-store';
import { navigateToSpace, navigateToSpaceTask } from '../lib/router';
import { SpaceDashboard } from '../components/space/SpaceDashboard';
import { SpaceTaskPane } from '../components/space/SpaceTaskPane';
import { SpaceAgentList } from '../components/space/SpaceAgentList';
import { WorkflowList } from '../components/space/WorkflowList';
import { VisualWorkflowEditor } from '../components/space/visual-editor/VisualWorkflowEditor';
import { WorkflowCanvas } from '../components/space/WorkflowCanvas';
import { SpaceSettings } from '../components/space/SpaceSettings';
import { SpaceCreateTaskDialog } from '../components/space/SpaceCreateTaskDialog';
import { WorkflowRunStartDialog } from '../components/space/WorkflowRunStartDialog';
import ChatContainer from './ChatContainer';
import { cn } from '../lib/utils';

interface SpaceIslandProps {
	spaceId: string;
	sessionViewId?: string | null; // When set, show this session content instead of space tabs
	taskViewId?: string | null; // When set, show SpaceTaskPane for this task
}

type SpaceTab = 'dashboard' | 'agents' | 'workflows' | 'settings';

const TABS: { id: SpaceTab; label: string }[] = [
	{ id: 'dashboard', label: 'Dashboard' },
	{ id: 'agents', label: 'Agents' },
	{ id: 'workflows', label: 'Workflows' },
	{ id: 'settings', label: 'Settings' },
];

export default function SpaceIsland({ spaceId, sessionViewId, taskViewId }: SpaceIslandProps) {
	const [activeTab, setActiveTab] = useState<SpaceTab>('dashboard');
	/** null = list view; 'new' = create editor; <id> = edit editor */
	const [workflowEditId, setWorkflowEditId] = useState<string | null>(null);
	const [createTaskOpen, setCreateTaskOpen] = useState(false);
	const [startWorkflowOpen, setStartWorkflowOpen] = useState(false);
	const loading = spaceStore.loading.value;
	const error = spaceStore.error.value;

	// Canvas mode: pick the first active run (runtime) or first workflow (template)
	const activeRuns = spaceStore.activeRuns.value;
	const workflows = spaceStore.workflows.value;
	const activeRun = activeRuns[0] ?? null;
	const defaultWorkflow = activeRun
		? (workflows.find((w) => w.id === activeRun.workflowId) ?? workflows[0] ?? null)
		: (workflows[0] ?? null);
	/** True when the canvas should be shown on the dashboard tab */
	const showCanvas = defaultWorkflow !== null;

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

	const editingWorkflow =
		workflowEditId && workflowEditId !== 'new'
			? workflows.find((w) => w.id === workflowEditId)
			: undefined;

	const showWorkflowEditor = activeTab === 'workflows' && workflowEditId !== null;

	// Session view: render ChatContainer instead of tabs
	if (sessionViewId) {
		return <ChatContainer key={sessionViewId} sessionId={sessionViewId} />;
	}

	// Task view: render SpaceTaskPane full-width instead of tabs
	if (taskViewId) {
		return (
			<div class="flex-1 flex flex-col overflow-hidden bg-dark-900" data-testid="space-task-pane">
				<SpaceTaskPane taskId={taskViewId} spaceId={spaceId} onClose={handleTaskPaneClose} />
			</div>
		);
	}

	return (
		<div class="flex-1 flex overflow-hidden bg-dark-900">
			{/* Main content — tabbed view */}
			<div class="flex-1 overflow-hidden flex flex-col min-w-0">
				{/* Tab bar — hidden when workflow editor is open (editor has its own back button) */}
				{!showWorkflowEditor && (
					<div class="flex border-b border-dark-700 px-4 flex-shrink-0" data-testid="space-tab-bar">
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
									{/* Canvas panel — shown on md+ when a workflow or active run exists */}
									{showCanvas && (
										<div
											class="hidden md:grid h-full overflow-hidden md:grid-cols-[minmax(0,1fr)_22rem]"
											data-testid="canvas-panel"
										>
											<div class="min-w-0 flex flex-col border-r border-dark-800 bg-dark-900/40">
												<div class="border-b border-dark-800 px-5 py-4">
													<div class="flex items-center justify-between gap-3">
														<div class="min-w-0">
															<p class="text-[11px] uppercase tracking-[0.22em] text-gray-600">
																Workflow Canvas
															</p>
															<p class="mt-1 text-sm text-gray-300">
																{activeRun ? 'Live orchestration view' : 'Template layout preview'}
															</p>
														</div>
														{activeRun ? (
															<div class="rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs text-blue-200">
																{activeRun.status.replace('_', ' ')}
															</div>
														) : (
															<div class="rounded-full border border-dark-700 bg-dark-900 px-3 py-1 text-xs text-gray-400">
																Template mode
															</div>
														)}
													</div>
													{activeRun && (
														<div class="mt-3 flex items-center gap-2 rounded-xl border border-blue-800/40 bg-blue-900/15 px-3 py-2">
															<span class="w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
															<span class="min-w-0 flex-1 truncate text-sm text-blue-200">
																{activeRun.title}
															</span>
														</div>
													)}
												</div>
												<WorkflowCanvas
													key={`${defaultWorkflow.id}:${activeRun?.id ?? 'template'}`}
													workflowId={defaultWorkflow.id}
													runId={activeRun?.id ?? null}
													spaceId={spaceId}
													class="flex-1 min-h-0"
												/>
											</div>
											<div class="min-h-0 overflow-y-auto bg-dark-950/70">
												<SpaceDashboard
													spaceId={spaceId}
													compact
													onCreateTask={() => setCreateTaskOpen(true)}
													onStartWorkflow={() => setStartWorkflowOpen(true)}
													onSelectTask={(taskId) => navigateToSpaceTask(spaceId, taskId)}
												/>
											</div>
										</div>
									)}
									{/* Fallback: shown on mobile, or when no canvas data */}
									<div
										class={cn('flex flex-col h-full overflow-y-auto', showCanvas && 'md:hidden')}
										data-testid="dashboard-fallback"
									>
										<SpaceDashboard
											spaceId={spaceId}
											onCreateTask={() => setCreateTaskOpen(true)}
											onStartWorkflow={() => setStartWorkflowOpen(true)}
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

			{/* Quick action dialogs */}
			<SpaceCreateTaskDialog isOpen={createTaskOpen} onClose={() => setCreateTaskOpen(false)} />
			{/* onStarted is intentionally omitted: spaceStore subscribes to
				space.workflowRun.created events and updates activeRuns reactively,
				so the canvas re-renders automatically without an explicit callback. */}
			<WorkflowRunStartDialog
				isOpen={startWorkflowOpen}
				onClose={() => setStartWorkflowOpen(false)}
				onSwitchToWorkflows={() => setActiveTab('workflows')}
			/>
		</div>
	);
}
