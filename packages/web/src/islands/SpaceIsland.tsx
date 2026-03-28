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
 *   - Template mode when no active run but workflows exist (editable gates)
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
import { WorkflowEditor } from '../components/space/WorkflowEditor';
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
type EditorMode = 'list' | 'visual';

/**
 * localStorage key for the user's preferred workflow editor mode.
 * Shared across all spaces — the preference is global, not per-space.
 */
const EDITOR_MODE_KEY = 'workflow-editor-mode';

const TABS: { id: SpaceTab; label: string }[] = [
	{ id: 'dashboard', label: 'Dashboard' },
	{ id: 'agents', label: 'Agents' },
	{ id: 'workflows', label: 'Workflows' },
	{ id: 'settings', label: 'Settings' },
];

function readStoredEditorMode(): EditorMode {
	try {
		const stored = localStorage.getItem(EDITOR_MODE_KEY);
		return stored === 'visual' ? 'visual' : 'list';
	} catch {
		return 'list';
	}
}

export default function SpaceIsland({ spaceId, sessionViewId, taskViewId }: SpaceIslandProps) {
	const [activeTab, setActiveTab] = useState<SpaceTab>('dashboard');
	/** null = list view; 'new' = create editor; <id> = edit editor */
	const [workflowEditId, setWorkflowEditId] = useState<string | null>(null);
	const [editorMode, setEditorMode] = useState<EditorMode>(readStoredEditorMode);
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

	/**
	 * Switch editor mode, persisting the preference to localStorage.
	 * Prompts the user to confirm if an editor is open — switching modes
	 * unmounts the active editor, which would discard any unsaved draft state.
	 */
	function handleSetEditorMode(mode: EditorMode) {
		if (mode === editorMode) return;
		if (
			workflowEditId !== null &&
			!confirm('Switching editor modes will discard any unsaved changes. Continue?')
		) {
			return;
		}
		setEditorMode(mode);
		try {
			localStorage.setItem(EDITOR_MODE_KEY, mode);
		} catch {
			// ignore storage errors
		}
	}

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
					<div class="flex border-b border-dark-700 px-4 flex-shrink-0">
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
						<div class="flex flex-col h-full overflow-hidden">
							{/* Editor mode toggle strip */}
							<div
								class="flex items-center justify-end px-4 py-1.5 border-b border-dark-700 bg-dark-900 flex-shrink-0"
								data-testid="editor-mode-toggle"
							>
								<div class="flex rounded-md overflow-hidden border border-dark-600 text-xs">
									<button
										type="button"
										data-testid="editor-mode-list"
										aria-pressed={editorMode === 'list'}
										onClick={() => handleSetEditorMode('list')}
										class={cn(
											'px-3 py-1 transition-colors',
											editorMode === 'list'
												? 'bg-dark-600 text-gray-100'
												: 'bg-dark-800 text-gray-500 hover:text-gray-300'
										)}
									>
										List
									</button>
									<button
										type="button"
										data-testid="editor-mode-visual"
										aria-pressed={editorMode === 'visual'}
										onClick={() => handleSetEditorMode('visual')}
										class={cn(
											'px-3 py-1 transition-colors',
											editorMode === 'visual'
												? 'bg-dark-600 text-gray-100'
												: 'bg-dark-800 text-gray-500 hover:text-gray-300'
										)}
									>
										Visual
									</button>
								</div>
							</div>

							{/* Active editor */}
							{editorMode === 'visual' ? (
								<VisualWorkflowEditor
									key={workflowEditId}
									workflow={editingWorkflow}
									onSave={() => setWorkflowEditId(null)}
									onCancel={() => setWorkflowEditId(null)}
								/>
							) : (
								<WorkflowEditor
									key={workflowEditId}
									workflow={editingWorkflow}
									onSave={() => setWorkflowEditId(null)}
									onCancel={() => setWorkflowEditId(null)}
								/>
							)}
						</div>
					) : (
						<>
							{activeTab === 'dashboard' && (
								<>
									{/* Canvas panel — shown on md+ when a workflow or active run exists */}
									{showCanvas && (
										<div
											class="hidden md:flex flex-col h-full overflow-hidden"
											data-testid="canvas-panel"
										>
											{/* Active-run banner */}
											{activeRun && (
												<div class="flex items-center gap-2 px-4 py-2 border-b border-dark-700 bg-dark-900 flex-shrink-0">
													<span class="w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
													<span class="text-xs text-blue-300 truncate">{activeRun.title}</span>
													<span class="ml-auto text-xs text-gray-600 capitalize flex-shrink-0">
														{activeRun.status.replace('_', ' ')}
													</span>
												</div>
											)}
											<WorkflowCanvas
												key={`${defaultWorkflow.id}:${activeRun?.id ?? 'template'}`}
												workflowId={defaultWorkflow.id}
												runId={activeRun?.id ?? null}
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
