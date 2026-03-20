/**
 * SpaceIsland — main content area for the Space view.
 *
 * 3-column layout:
 * - Left (~240px): SpaceNavPanel — workflow runs, tasks, nav links
 * - Middle (flex-1): tabbed view — Dashboard | Agents | Workflows | Settings
 * - Right (~320px, conditional): SpaceTaskPane when a task is selected
 */

import { useState, useEffect } from 'preact/hooks';
import { spaceStore } from '../lib/space-store';
import { currentSpaceTaskIdSignal } from '../lib/signals';
import { navigateToSpaceTask, navigateToSpace } from '../lib/router';
import { SpaceNavPanel } from '../components/space/SpaceNavPanel';
import { SpaceDashboard } from '../components/space/SpaceDashboard';
import { SpaceTaskPane } from '../components/space/SpaceTaskPane';
import { SpaceAgentList } from '../components/space/SpaceAgentList';
import { WorkflowList } from '../components/space/WorkflowList';
import { WorkflowEditor } from '../components/space/WorkflowEditor';
import { SpaceSettings } from '../components/space/SpaceSettings';
import { cn } from '../lib/utils';

interface SpaceIslandProps {
	spaceId: string;
}

type SpaceTab = 'dashboard' | 'agents' | 'workflows' | 'settings';

const TABS: { id: SpaceTab; label: string }[] = [
	{ id: 'dashboard', label: 'Dashboard' },
	{ id: 'agents', label: 'Agents' },
	{ id: 'workflows', label: 'Workflows' },
	{ id: 'settings', label: 'Settings' },
];

export default function SpaceIsland({ spaceId }: SpaceIslandProps) {
	const [activeTab, setActiveTab] = useState<SpaceTab>('dashboard');
	const [activeRunId, setActiveRunId] = useState<string | null>(null);
	/** null = list view; 'new' = create editor; <id> = edit editor */
	const [workflowEditId, setWorkflowEditId] = useState<string | null>(null);
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

	// Reset workflow edit state when switching away from workflows tab
	useEffect(() => {
		if (activeTab !== 'workflows') {
			setWorkflowEditId(null);
		}
	}, [activeTab]);

	const handleRunSelect = (runId: string) => {
		setActiveRunId(runId);
		setActiveTab('dashboard');
		// Clear task selection when switching to a run
		currentSpaceTaskIdSignal.value = null;
	};

	const handleTaskSelect = (taskId: string) => {
		setActiveRunId(null);
		setActiveTab('dashboard');
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

	const space = spaceStore.space.value;
	const workflows = spaceStore.workflows.value;

	const editingWorkflow =
		workflowEditId && workflowEditId !== 'new'
			? workflows.find((w) => w.id === workflowEditId)
			: undefined;

	const showWorkflowEditor = activeTab === 'workflows' && workflowEditId !== null;

	return (
		<div class="flex-1 flex overflow-hidden bg-dark-900">
			{/* Left column — navigation panel */}
			<div class="w-60 flex-shrink-0 border-r border-dark-700 overflow-hidden flex flex-col">
				<SpaceNavPanel
					spaceId={spaceId}
					activeTaskId={activeTaskId}
					activeRunId={activeRunId}
					activeView={activeTab}
					onRunSelect={handleRunSelect}
					onTaskSelect={handleTaskSelect}
					onAgentsClick={() => setActiveTab('agents')}
				/>
			</div>

			{/* Middle column — tabbed content */}
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
						<WorkflowEditor
							workflow={editingWorkflow}
							onSave={() => setWorkflowEditId(null)}
							onCancel={() => setWorkflowEditId(null)}
						/>
					) : (
						<>
							{activeTab === 'dashboard' && <SpaceDashboard spaceId={spaceId} />}
							{activeTab === 'agents' && <SpaceAgentList />}
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

			{/* Right column — task detail pane (conditionally shown) */}
			{activeTaskId && (
				<div class="hidden md:flex w-80 flex-shrink-0 border-l border-dark-700 overflow-hidden flex-col">
					<SpaceTaskPane taskId={activeTaskId} onClose={handleTaskPaneClose} />
				</div>
			)}
		</div>
	);
}
