import { useEffect, useState } from 'preact/hooks';
import type { Space } from '@neokai/shared';
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@neokai/ui';
import { spaceStore } from '../../lib/space-store';
import { cn } from '../../lib/utils';
import { SpaceAgentList } from './SpaceAgentList';
import { SpaceSettings } from './SpaceSettings';
import { WorkflowList } from './WorkflowList';
import { VisualWorkflowEditor } from './visual-editor/VisualWorkflowEditor';

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
	const [activeTab, setActiveTab] = useState<ConfigureTab>('agents');
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
			<div class="mx-auto flex w-full max-w-7xl min-h-0 flex-1 flex-col gap-3 lg:gap-4">
				{!showWorkflowEditor && (
					<TabGroup
						selectedIndex={selectedIndex}
						onChange={(index: number) => setActiveTab(CONFIGURE_TABS[index]?.id ?? 'agents')}
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
								<div class="h-full overflow-y-auto p-4 sm:p-5 lg:p-6">
									<SpaceAgentList />
								</div>
							</TabPanel>
							<TabPanel>
								<WorkflowList
									spaceId={space.id}
									spaceName={space.name}
									workflows={workflows}
									onCreateWorkflow={() => setWorkflowEditId('new')}
									onEditWorkflow={(id) => setWorkflowEditId(id)}
								/>
							</TabPanel>
							<TabPanel>
								<SpaceSettings space={space} />
							</TabPanel>
						</TabPanels>
					</TabGroup>
				)}

				{showWorkflowEditor && (
					<div class="min-h-0 flex-1 overflow-hidden rounded-3xl border border-dark-700 bg-dark-950/70 lg:rounded-[28px]">
						<VisualWorkflowEditor
							key={workflowEditId}
							workflow={editingWorkflow}
							// Keep editor open after save; exit is explicit via Back/Cancel.
							onSave={() => undefined}
							onCancel={() => setWorkflowEditId(null)}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
