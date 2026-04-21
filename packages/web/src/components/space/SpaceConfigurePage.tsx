import { useEffect, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import type { Space } from '@neokai/shared';
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@neokai/ui';
import { spaceStore } from '../../lib/space-store';
import { currentSpaceConfigureTabSignal, currentSpaceIdSignal } from '../../lib/signals';
import { navigateToSpaceConfigure } from '../../lib/router';
import { cn } from '../../lib/utils';

const SpaceAgentList = lazy(() =>
	import('./SpaceAgentList').then((m) => ({ default: m.SpaceAgentList }))
);
const SpaceSettings = lazy(() =>
	import('./SpaceSettings').then((m) => ({ default: m.SpaceSettings }))
);
const WorkflowList = lazy(() =>
	import('./WorkflowList').then((m) => ({ default: m.WorkflowList }))
);
const VisualWorkflowEditor = lazy(() =>
	import('./visual-editor/VisualWorkflowEditor').then((m) => ({
		default: m.VisualWorkflowEditor,
	}))
);

const lazyFallback = (
	<div class="flex-1 flex items-center justify-center py-12">
		<div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
	</div>
);

type ConfigureTab = 'agents' | 'workflows' | 'settings';

const CONFIGURE_TABS: Array<{
	id: ConfigureTab;
	label: string;
	count: (args: { agentCount: number; workflowCount: number }) => number;
}> = [
	{ id: 'agents', label: 'Agents', count: ({ agentCount }) => agentCount },
	{ id: 'workflows', label: 'Workflows', count: ({ workflowCount }) => workflowCount },
	{ id: 'settings', label: 'Settings', count: () => 1 },
];

interface SpaceConfigurePageProps {
	space: Space;
}

export function SpaceConfigurePage({ space }: SpaceConfigurePageProps) {
	const agents = spaceStore.agents.value;
	const workflows = spaceStore.workflows.value;
	const configLoaded = spaceStore.configDataLoaded.value;

	useEffect(() => {
		spaceStore.ensureConfigData().catch(() => {});
		spaceStore.ensureNodeExecutions().catch(() => {});
	}, [space.id]);
	const activeTab = currentSpaceConfigureTabSignal.value;
	const spaceId = currentSpaceIdSignal.value ?? '';
	/** null = list view; 'new' = create editor; <id> = edit editor */
	const [workflowEditId, setWorkflowEditId] = useState<string | null>(null);

	const editingWorkflow =
		workflowEditId && workflowEditId !== 'new'
			? workflows.find((workflow) => workflow.id === workflowEditId)
			: undefined;

	const showWorkflowEditor = activeTab === 'workflows' && workflowEditId !== null;
	const selectedIndex = Math.max(
		0,
		CONFIGURE_TABS.findIndex((tab) => tab.id === activeTab)
	);

	if (!configLoaded) {
		return (
			<div class="flex-1 flex items-center justify-center">
				<div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
			</div>
		);
	}

	return (
		<div class="flex h-full flex-col overflow-y-auto p-3 sm:p-4 lg:p-6">
			<div class="mx-auto flex w-full max-w-7xl min-h-[calc(100%+1px)] flex-1 flex-col gap-3 lg:gap-4">
				{!showWorkflowEditor && (
					<TabGroup
						selectedIndex={selectedIndex}
						onChange={(index: number) =>
							navigateToSpaceConfigure(spaceId, CONFIGURE_TABS[index]?.id ?? 'agents')
						}
					>
						<TabList
							class="flex items-center gap-6 border-b border-dark-700 px-6"
							data-testid="space-configure-tab-bar"
						>
							{CONFIGURE_TABS.map((tab) => (
								<Tab
									key={tab.id}
									data-testid={`space-configure-tab-${tab.id}`}
									class={cn(
										'flex items-center gap-2 border-b-2 px-1 py-3 text-sm font-medium transition-colors',
										activeTab === tab.id
											? 'border-blue-400 text-gray-100'
											: 'border-transparent text-gray-400 hover:text-gray-200'
									)}
								>
									<span>{tab.label}</span>
									<span class="rounded-full bg-dark-800 px-2 py-0.5 text-xs text-gray-300">
										{tab.count({
											agentCount: agents.length,
											workflowCount: workflows.length,
										})}
									</span>
								</Tab>
							))}
						</TabList>

						<TabPanels class="min-h-0 flex-1 overflow-hidden rounded-3xl border border-dark-700 bg-dark-950/70 lg:rounded-[28px]">
							<TabPanel>
								<Suspense fallback={lazyFallback}>
									<div class="h-full min-h-[calc(100%+1px)] overflow-y-auto p-4 sm:p-5 lg:p-6">
										<SpaceAgentList />
									</div>
								</Suspense>
							</TabPanel>
							<TabPanel>
								<Suspense fallback={lazyFallback}>
									<WorkflowList
										spaceId={space.id}
										spaceName={space.name}
										workflows={workflows}
										onCreateWorkflow={() => setWorkflowEditId('new')}
										onEditWorkflow={(id) => setWorkflowEditId(id)}
									/>
								</Suspense>
							</TabPanel>
							<TabPanel>
								<Suspense fallback={lazyFallback}>
									<SpaceSettings space={space} />
								</Suspense>
							</TabPanel>
						</TabPanels>
					</TabGroup>
				)}

				{showWorkflowEditor && (
					<Suspense fallback={lazyFallback}>
						<div class="min-h-0 flex-1 overflow-hidden rounded-3xl border border-dark-700 bg-dark-950/70 lg:rounded-[28px]">
							<VisualWorkflowEditor
								key={workflowEditId}
								workflow={editingWorkflow}
								// Keep editor open after save; exit is explicit via Back/Cancel.
								onSave={() => undefined}
								onCancel={() => setWorkflowEditId(null)}
							/>
						</div>
					</Suspense>
				)}
			</div>
		</div>
	);
}
