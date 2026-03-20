/**
 * SpaceIsland — main content area for the Space view.
 * Renders a tabbed interface: Agents | Workflows | Settings
 */

import { useState, useEffect } from 'preact/hooks';
import { spaceStore } from '../lib/space-store.ts';
import { SpaceAgentList } from '../components/space/SpaceAgentList.tsx';
import { WorkflowList } from '../components/space/WorkflowList.tsx';
import { SpaceSettings } from '../components/space/SpaceSettings.tsx';
import { cn } from '../lib/utils.ts';

type SpaceTab = 'agents' | 'workflows' | 'settings';

interface SpaceIslandProps {
	spaceId: string;
}

export default function SpaceIsland({ spaceId }: SpaceIslandProps) {
	const [activeTab, setActiveTab] = useState<SpaceTab>('agents');

	// Subscribe to the space in SpaceStore
	useEffect(() => {
		spaceStore.selectSpace(spaceId);
		return () => {
			spaceStore.clearSpace();
		};
	}, [spaceId]);

	const space = spaceStore.space.value;
	const agents = spaceStore.agents.value;
	const workflows = spaceStore.workflows.value;
	const loading = spaceStore.loading.value;
	const error = spaceStore.error.value;

	if (loading && !space) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="flex items-center gap-3 text-gray-400">
					<svg class="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
						<circle
							class="opacity-25"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							stroke-width="4"
						/>
						<path
							class="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
						/>
					</svg>
					<span class="text-sm">Loading space…</span>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<p class="text-sm text-red-400 mb-1">Failed to load space</p>
					<p class="text-xs text-gray-500 font-mono">{error}</p>
				</div>
			</div>
		);
	}

	if (!space) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<div class="text-4xl mb-3">🚀</div>
					<p class="text-sm text-gray-400">Space</p>
					<p class="text-xs text-gray-600 mt-1 font-mono">{spaceId}</p>
				</div>
			</div>
		);
	}

	const tabs: { id: SpaceTab; label: string }[] = [
		{ id: 'agents', label: 'Agents' },
		{ id: 'workflows', label: 'Workflows' },
		{ id: 'settings', label: 'Settings' },
	];

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Header */}
			<div class="flex items-center justify-between px-6 py-4 border-b border-dark-700 flex-shrink-0">
				<div class="min-w-0">
					<h1 class="text-base font-semibold text-gray-100 truncate">{space.name}</h1>
					{space.description && (
						<p class="text-xs text-gray-500 mt-0.5 truncate">{space.description}</p>
					)}
				</div>
			</div>

			{/* Tabs */}
			<div class="flex border-b border-dark-700 px-6 flex-shrink-0">
				{tabs.map((tab) => (
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

			{/* Tab content */}
			<div class="flex-1 overflow-hidden">
				{activeTab === 'agents' && (
					<SpaceAgentList spaceId={spaceId} spaceName={space.name} agents={agents} />
				)}
				{activeTab === 'workflows' && (
					<WorkflowList spaceId={spaceId} spaceName={space.name} workflows={workflows} />
				)}
				{activeTab === 'settings' && <SpaceSettings space={space} />}
			</div>
		</div>
	);
}
