/**
 * SpaceAgentList Component
 *
 * Displays all agents configured for a Space.
 * - Agent cards: name, role badge, model, description preview
 * - "Create Agent" button to open the editor
 * - Empty state: "No custom agents yet. Create one to get started."
 * - Subscribes to spaceAgent.* events via SpaceStore
 * - Delete confirmation with workflow reference warning
 */

import { useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import type { SpaceAgent } from '@neokai/shared';
import { SpaceAgentEditor } from './SpaceAgentEditor';

interface SpaceAgentListProps {
	spaceId: string;
}

function RoleBadge({ role }: { role: string }) {
	const colorMap: Record<string, string> = {
		worker: 'bg-blue-900/40 text-blue-300 border-blue-800/60',
		reviewer: 'bg-purple-900/40 text-purple-300 border-purple-800/60',
		orchestrator: 'bg-amber-900/40 text-amber-300 border-amber-800/60',
		coder: 'bg-blue-900/40 text-blue-300 border-blue-800/60',
		planner: 'bg-amber-900/40 text-amber-300 border-amber-800/60',
		general: 'bg-gray-800 text-gray-400 border-gray-700',
	};
	const colorClass = colorMap[role.toLowerCase()] ?? 'bg-gray-800 text-gray-400 border-gray-700';
	return <span class={`text-xs px-2 py-0.5 rounded border font-medium ${colorClass}`}>{role}</span>;
}

interface AgentCardProps {
	agent: SpaceAgent;
	onEdit: (agent: SpaceAgent) => void;
	onDelete: (agent: SpaceAgent) => void;
}

function AgentCard({ agent, onEdit, onDelete }: AgentCardProps) {
	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-4 hover:border-dark-600 transition-colors">
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="text-sm font-medium text-gray-100">{agent.name}</span>
						<RoleBadge role={agent.role} />
						{agent.model && <span class="text-xs text-gray-500 font-mono">{agent.model}</span>}
					</div>
					{agent.description && (
						<p class="text-xs text-gray-500 mt-1.5 line-clamp-2">{agent.description}</p>
					)}
					{agent.tools && agent.tools.length > 0 && (
						<div class="flex gap-1 flex-wrap mt-2">
							{agent.tools.slice(0, 4).map((tool) => (
								<span
									key={tool}
									class="text-xs bg-dark-800 text-gray-500 px-1.5 py-0.5 rounded border border-dark-700"
								>
									{tool}
								</span>
							))}
							{agent.tools.length > 4 && (
								<span class="text-xs text-gray-600">+{agent.tools.length - 4} more</span>
							)}
						</div>
					)}
				</div>
				<div class="flex items-center gap-1 flex-shrink-0">
					<button
						type="button"
						onClick={() => onEdit(agent)}
						class="p-1.5 rounded text-gray-500 hover:text-gray-300 hover:bg-dark-700 transition-colors"
						aria-label={`Edit ${agent.name}`}
					>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
							/>
						</svg>
					</button>
					<button
						type="button"
						onClick={() => onDelete(agent)}
						class="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-dark-700 transition-colors"
						aria-label={`Delete ${agent.name}`}
					>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
							/>
						</svg>
					</button>
				</div>
			</div>
		</div>
	);
}

function PlusIcon() {
	return (
		<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 4v16m8-8H4" />
		</svg>
	);
}

function AgentIcon() {
	return (
		<svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
			/>
		</svg>
	);
}

export function SpaceAgentList({ spaceId }: SpaceAgentListProps) {
	const agents = spaceStore.agents.value;
	const loading = spaceStore.loading.value;
	const workflows = spaceStore.workflows.value;

	const [editorOpen, setEditorOpen] = useState(false);
	const [editingAgent, setEditingAgent] = useState<SpaceAgent | null>(null);
	const [deletingAgent, setDeletingAgent] = useState<SpaceAgent | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);

	function getWorkflowNamesReferencingAgent(agentId: string): string[] {
		return workflows
			.filter((wf) => wf.steps?.some((step) => step.agentId === agentId))
			.map((wf) => wf.name);
	}

	const handleEdit = (agent: SpaceAgent) => {
		setEditingAgent(agent);
		setEditorOpen(true);
	};

	const handleCreate = () => {
		setEditingAgent(null);
		setEditorOpen(true);
	};

	const handleEditorClose = () => {
		setEditorOpen(false);
		setEditingAgent(null);
	};

	const handleDeleteClick = (agent: SpaceAgent) => {
		setDeletingAgent(agent);
		setDeleteError(null);
	};

	const handleDeleteConfirm = async () => {
		if (!deletingAgent) return;
		setDeleting(true);
		setDeleteError(null);
		try {
			await spaceStore.deleteAgent(deletingAgent.id);
			setDeletingAgent(null);
		} catch (err) {
			setDeleteError(err instanceof Error ? err.message : 'Failed to delete agent');
		} finally {
			setDeleting(false);
		}
	};

	const referencedWorkflows = deletingAgent
		? getWorkflowNamesReferencingAgent(deletingAgent.id)
		: [];

	const deleteMessage = deletingAgent
		? referencedWorkflows.length > 0
			? `"${deletingAgent.name}" is used in the following workflows: ${referencedWorkflows.join(', ')}. Deleting this agent may break those workflows. Are you sure you want to delete it?`
			: `Are you sure you want to delete "${deletingAgent.name}"? This action cannot be undone.`
		: '';

	const existingAgentNames = agents.filter((a) => a.id !== editingAgent?.id).map((a) => a.name);

	if (loading) {
		return (
			<div class="flex items-center justify-center h-32">
				<span class="text-xs text-gray-600 animate-pulse">Loading agents...</span>
			</div>
		);
	}

	return (
		<div class="flex flex-col h-full">
			{/* Header */}
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-sm font-semibold text-gray-200">Agents</h2>
				<Button size="sm" onClick={handleCreate} icon={<PlusIcon />}>
					Create Agent
				</Button>
			</div>

			{/* Agent list or empty state */}
			{agents.length === 0 ? (
				<div class="flex flex-col items-center justify-center flex-1 py-12 text-center">
					<div class="w-10 h-10 rounded-full bg-dark-800 flex items-center justify-center mb-3">
						<AgentIcon />
					</div>
					<p class="text-sm text-gray-400 font-medium">No custom agents yet</p>
					<p class="text-xs text-gray-600 mt-1">Create one to get started.</p>
					<div class="mt-4">
						<Button size="sm" variant="secondary" onClick={handleCreate}>
							Create Agent
						</Button>
					</div>
				</div>
			) : (
				<div class="space-y-2 overflow-y-auto flex-1">
					{agents.map((agent) => (
						<AgentCard
							key={agent.id}
							agent={agent}
							onEdit={handleEdit}
							onDelete={handleDeleteClick}
						/>
					))}
				</div>
			)}

			{/* Editor Modal */}
			{editorOpen && (
				<SpaceAgentEditor
					spaceId={spaceId}
					agent={editingAgent}
					existingAgentNames={existingAgentNames}
					onSave={handleEditorClose}
					onCancel={handleEditorClose}
				/>
			)}

			{/* Delete Confirmation */}
			<ConfirmModal
				isOpen={!!deletingAgent}
				onClose={() => {
					setDeletingAgent(null);
					setDeleteError(null);
				}}
				onConfirm={handleDeleteConfirm}
				title="Delete Agent"
				message={deleteMessage}
				confirmText="Delete"
				confirmButtonVariant={referencedWorkflows.length > 0 ? 'warning' : 'danger'}
				isLoading={deleting}
				error={deleteError}
			/>
		</div>
	);
}
