import { useState } from 'preact/hooks';
import type { Space, SpaceWorkflow } from '@neokai/shared';
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
	description: string;
}> = [
	{
		id: 'agents',
		label: 'Agents',
		description: 'Define the specialist roles available in this space.',
	},
	{
		id: 'workflows',
		label: 'Workflows',
		description: 'Shape the execution graph that fans work out across agents.',
	},
	{
		id: 'settings',
		label: 'Settings',
		description: 'Adjust space metadata, export, and lifecycle controls.',
	},
];

interface SpaceConfigurePageProps {
	space: Space;
	workflows: SpaceWorkflow[];
}

function StatPill({
	label,
	value,
}: {
	label: string;
	value: string;
}) {
	return (
		<div class="rounded-xl border border-dark-700 bg-dark-900/70 px-3 py-2">
			<p class="text-[10px] uppercase tracking-[0.18em] text-gray-500">{label}</p>
			<p class="mt-1 text-sm font-semibold text-gray-100">{value}</p>
		</div>
	);
}

function ConfigureTabButton({
	id,
	label,
	description,
	active,
	onClick,
}: {
	id: ConfigureTab;
	label: string;
	description: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-testid={`space-configure-tab-${id}`}
			class={cn(
				'rounded-2xl border px-4 py-3 text-left transition-colors',
				active
					? 'border-blue-500/40 bg-blue-500/10'
					: 'border-dark-700 bg-dark-900/50 hover:border-dark-600 hover:bg-dark-900'
			)}
		>
			<p class={cn('text-sm font-medium', active ? 'text-blue-50' : 'text-gray-100')}>{label}</p>
			<p class="mt-1 text-xs leading-5 text-gray-500">{description}</p>
		</button>
	);
}

export function SpaceConfigurePage({ space, workflows }: SpaceConfigurePageProps) {
	const agents = spaceStore.agents.value;
	const [activeTab, setActiveTab] = useState<ConfigureTab>('agents');
	/** null = list view; 'new' = create editor; <id> = edit editor */
	const [workflowEditId, setWorkflowEditId] = useState<string | null>(null);

	const editingWorkflow =
		workflowEditId && workflowEditId !== 'new'
			? workflows.find((workflow) => workflow.id === workflowEditId)
			: undefined;

	const showWorkflowEditor = activeTab === 'workflows' && workflowEditId !== null;
	const workspacePath = space.workspacePath ?? '';
	const workspaceName = workspacePath
		? workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath
		: 'Not set';

	return (
		<div class="flex h-full flex-col overflow-y-auto p-6">
			<div class="mx-auto flex w-full max-w-7xl flex-1 min-h-0 flex-col gap-6">
				{!showWorkflowEditor && (
					<section class="rounded-[28px] border border-dark-700 bg-dark-900/90 px-6 py-6">
						<div class="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
							<div class="min-w-0">
								<p class="text-[11px] uppercase tracking-[0.22em] text-gray-600">Configure</p>
								<h1 class="mt-3 text-3xl font-semibold tracking-tight text-gray-100">
									{space.name} setup
								</h1>
								<p class="mt-3 max-w-3xl text-sm leading-6 text-gray-400">
									Adjust the operator surface behind this space: who can work here, how work
									fans out, and what controls govern the environment.
								</p>
							</div>
							<div class="grid w-full gap-3 sm:grid-cols-3 xl:w-[32rem]">
								<StatPill label="Agents" value={String(agents.length)} />
								<StatPill label="Workflows" value={String(workflows.length)} />
								<StatPill label="Workspace" value={workspaceName} />
							</div>
						</div>

						<div
							class="mt-6 grid gap-3 lg:grid-cols-3"
							data-testid="space-configure-tab-bar"
						>
							{CONFIGURE_TABS.map((tab) => (
								<ConfigureTabButton
									key={tab.id}
									id={tab.id}
									label={tab.label}
									description={tab.description}
									active={activeTab === tab.id}
									onClick={() => setActiveTab(tab.id)}
								/>
							))}
						</div>
					</section>
				)}

				<div class="min-h-0 flex-1 overflow-hidden rounded-[28px] border border-dark-700 bg-dark-950/70">
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
		</div>
	);
}
