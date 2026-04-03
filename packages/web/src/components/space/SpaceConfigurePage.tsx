import { useState } from 'preact/hooks';
import type { Space, SpaceWorkflow } from '@neokai/shared';
import { SpaceAgentList } from './SpaceAgentList';
import { WorkflowList } from './WorkflowList';
import { VisualWorkflowEditor } from './visual-editor/VisualWorkflowEditor';
import { SpaceSettings } from './SpaceSettings';
import { cn } from '../../lib/utils';

type ConfigureTab = 'agents' | 'workflows' | 'settings';

const CONFIGURE_TABS: { id: ConfigureTab; label: string }[] = [
	{ id: 'agents', label: 'Agents' },
	{ id: 'workflows', label: 'Workflows' },
	{ id: 'settings', label: 'Settings' },
];

interface SpaceConfigurePageProps {
	space: Space;
	workflows: SpaceWorkflow[];
}

export function SpaceConfigurePage({ space, workflows }: SpaceConfigurePageProps) {
	const [activeTab, setActiveTab] = useState<ConfigureTab>('agents');
	/** null = list view; 'new' = create editor; <id> = edit editor */
	const [workflowEditId, setWorkflowEditId] = useState<string | null>(null);

	const editingWorkflow =
		workflowEditId && workflowEditId !== 'new'
			? workflows.find((workflow) => workflow.id === workflowEditId)
			: undefined;

	const showWorkflowEditor = activeTab === 'workflows' && workflowEditId !== null;

	return (
		<div class="flex h-full flex-col overflow-hidden">
			{!showWorkflowEditor && (
				<div
					class="flex items-center gap-2 border-b border-dark-700 px-6 py-3"
					data-testid="space-configure-tab-bar"
				>
					{CONFIGURE_TABS.map((tab) => (
						<button
							key={tab.id}
							type="button"
							onClick={() => setActiveTab(tab.id)}
							class={cn(
								'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
								activeTab === tab.id
									? 'bg-dark-700 text-gray-100'
									: 'text-gray-400 hover:bg-dark-800 hover:text-gray-200'
							)}
						>
							{tab.label}
						</button>
					))}
				</div>
			)}

			<div class="min-h-0 flex-1 overflow-hidden">
				{showWorkflowEditor ? (
					<VisualWorkflowEditor
						key={workflowEditId}
						workflow={editingWorkflow}
						onSave={() => setWorkflowEditId(null)}
						onCancel={() => setWorkflowEditId(null)}
					/>
				) : (
					<>
						{activeTab === 'agents' && (
							<div class="h-full overflow-y-auto p-6">
								<SpaceAgentList />
							</div>
						)}
						{activeTab === 'workflows' && (
							<WorkflowList
								spaceId={space.id}
								spaceName={space.name}
								workflows={workflows}
								onCreateWorkflow={() => setWorkflowEditId('new')}
								onEditWorkflow={(id) => setWorkflowEditId(id)}
							/>
						)}
						{activeTab === 'settings' && <SpaceSettings space={space} />}
					</>
				)}
			</div>
		</div>
	);
}
