/**
 * SpaceAgentList Component
 *
 * Displays all agents configured for a Space.
 * - Agent cards: name, model, description preview
 * - "Create Agent" button to open the editor
 * - Empty state: "No custom agents yet. Create one to get started."
 * - Subscribes to spaceAgent.* events via SpaceStore
 * - Delete confirmation with workflow reference blocking:
 *   When an agent is referenced by workflow steps, deletion is blocked
 *   with a clear message. When unreferenced, a standard confirm dialog is shown.
 */

import { useState, useEffect } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { Modal } from '../ui/Modal';
import type { SpaceAgent, AgentDriftReport, TaskAgentConfig } from '@neokai/shared';
import { SpaceAgentEditor } from './SpaceAgentEditor';
import { WorkflowModelSelect } from './visual-editor/WorkflowModelSelect';
import { connectionManager } from '../../lib/connection-manager';
import { toast } from '../../lib/toast';

interface AgentCardProps {
	agent: SpaceAgent;
	drifted: boolean;
	syncing: boolean;
	onEdit: (agent: SpaceAgent) => void;
	onDelete: (agent: SpaceAgent) => void;
	onSync: (agent: SpaceAgent) => void;
}

function AgentCard({ agent, drifted, syncing, onEdit, onDelete, onSync }: AgentCardProps) {
	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-4 hover:border-dark-600 transition-colors">
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="text-sm font-medium text-gray-100">{agent.name}</span>
						{agent.model && <span class="text-xs text-gray-500 font-mono">{agent.model}</span>}
						{drifted && (
							<span
								class="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-amber-900/30 border border-amber-700/50 rounded text-amber-400"
								title={`This agent was seeded from the "${agent.templateName}" preset and has drifted from the current definition.`}
							>
								<svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
									/>
								</svg>
								Out of sync
							</span>
						)}
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
					{drifted && (
						<button
							type="button"
							onClick={() => onSync(agent)}
							disabled={syncing}
							class="px-2.5 py-1 text-xs text-amber-400 hover:text-amber-200 bg-dark-800 hover:bg-dark-700 rounded border border-amber-700/50 hover:border-amber-600/70 transition-colors disabled:opacity-50"
							title="Sync from template (overwrites description, tools, and prompt)"
						>
							{syncing ? 'Syncing…' : 'Sync from template'}
						</button>
					)}
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

/**
 * DEFAULT_TASK_AGENT_MODEL must match the constant in task-agent.ts.
 * Duplicated here to avoid importing daemon code in the web bundle.
 */
const DEFAULT_TASK_AGENT_MODEL = 'claude-sonnet-4-6';

interface TaskAgentCardProps {
	spaceId: string;
	taskAgentConfig?: TaskAgentConfig;
	defaultModel?: string;
}

function TaskAgentCard({ spaceId, taskAgentConfig, defaultModel }: TaskAgentCardProps) {
	const [editing, setEditing] = useState(false);
	const [model, setModel] = useState<string | undefined>(taskAgentConfig?.model);
	const [customPrompt, setCustomPrompt] = useState(taskAgentConfig?.customPrompt ?? '');
	const [saving, setSaving] = useState(false);

	// Sync local state when props change (e.g. after save)
	useEffect(() => {
		setModel(taskAgentConfig?.model);
		setCustomPrompt(taskAgentConfig?.customPrompt ?? '');
	}, [taskAgentConfig?.model, taskAgentConfig?.customPrompt]);

	const resolvedModel = taskAgentConfig?.model ?? defaultModel ?? DEFAULT_TASK_AGENT_MODEL;
	const hasOverrides = !!(taskAgentConfig?.model || taskAgentConfig?.customPrompt);

	async function handleSave() {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server');
			return;
		}
		try {
			setSaving(true);
			const config: TaskAgentConfig = {};
			if (model) config.model = model;
			if (customPrompt.trim()) config.customPrompt = customPrompt.trim();
			// Send null to clear if both are empty, otherwise send the config
			await hub.request('space.update', {
				id: spaceId,
				taskAgentConfig: config.model || config.customPrompt ? config : null,
			});
			setEditing(false);
			toast.success('Task Agent config updated');
		} catch (err) {
			toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setSaving(false);
		}
	}

	async function handleReset() {
		if (
			!confirm(
				'Reset Task Agent to defaults? This will clear the model override and custom prompt.'
			)
		) {
			return;
		}
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server');
			return;
		}
		try {
			setSaving(true);
			await hub.request('space.update', {
				id: spaceId,
				taskAgentConfig: null,
			});
			setEditing(false);
			toast.success('Task Agent reset to defaults');
		} catch (err) {
			toast.error(`Failed to reset: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div class="bg-dark-850 border border-blue-900/30 rounded-lg p-4">
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="text-xs font-medium text-blue-400 uppercase tracking-wider">Built-in</span>
						<span class="text-sm font-medium text-gray-100">Task Agent</span>
						<span class="text-xs text-gray-500 font-mono">{resolvedModel}</span>
						{hasOverrides && (
							<span class="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-blue-900/30 border border-blue-700/50 rounded text-blue-400">
								Customized
							</span>
						)}
					</div>
					<p class="text-xs text-gray-500 mt-1.5">
						Orchestration agent that manages task workflows, coordinates node agents, and handles
						human gates.
					</p>
					{taskAgentConfig?.customPrompt && (
						<p class="text-xs text-gray-400 mt-1 line-clamp-2 italic">
							{taskAgentConfig.customPrompt}
						</p>
					)}
				</div>
				<div class="flex items-center gap-1 flex-shrink-0">
					{hasOverrides && (
						<button
							type="button"
							onClick={handleReset}
							disabled={saving}
							class="px-2.5 py-1 text-xs text-gray-400 hover:text-gray-200 bg-dark-800 hover:bg-dark-700 rounded border border-dark-700 hover:border-dark-600 transition-colors disabled:opacity-50"
							title="Reset to code defaults"
						>
							{saving ? 'Resetting...' : 'Reset to defaults'}
						</button>
					)}
					<button
						type="button"
						onClick={() => setEditing(!editing)}
						class="p-1.5 rounded text-gray-500 hover:text-gray-300 hover:bg-dark-700 transition-colors"
						aria-label="Edit Task Agent"
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
				</div>
			</div>

			{editing && (
				<div class="mt-4 pt-3 border-t border-dark-700 space-y-3">
					<div>
						<label class="block text-xs font-medium text-gray-400 mb-1">Model Override</label>
						<p class="text-xs text-gray-500 mb-2">
							Overrides the model used by the Task Agent. Falls back to the space default or{' '}
							<span class="font-mono">{DEFAULT_TASK_AGENT_MODEL}</span> when not set.
						</p>
						<WorkflowModelSelect
							value={model}
							onChange={(val) => setModel(val)}
							testId="task-agent-model-select"
							className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
						/>
					</div>
					<div>
						<label class="block text-xs font-medium text-gray-400 mb-1">
							Custom Prompt
							<span class="text-gray-600 ml-1">(optional)</span>
						</label>
						<p class="text-xs text-gray-500 mb-1">
							Appended to the Task Agent system prompt after the contract sections.
						</p>
						<textarea
							value={customPrompt}
							onInput={(e) => setCustomPrompt((e.target as HTMLTextAreaElement).value)}
							placeholder="e.g. Always prefer squashing commits..."
							rows={4}
							class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y text-sm"
						/>
					</div>
					<div class="flex gap-2 justify-end">
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={() => {
								setEditing(false);
								setModel(taskAgentConfig?.model);
								setCustomPrompt(taskAgentConfig?.customPrompt ?? '');
							}}
						>
							Cancel
						</Button>
						<Button type="button" size="sm" loading={saving} onClick={handleSave}>
							Save
						</Button>
					</div>
				</div>
			)}
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

export function SpaceAgentList() {
	const agents = spaceStore.agents.value;
	const loading = spaceStore.loading.value;
	const workflows = spaceStore.workflows.value;
	const spaceId = spaceStore.spaceId.value;
	const space = spaceStore.space.value;

	const [editorOpen, setEditorOpen] = useState(false);
	const [editingAgent, setEditingAgent] = useState<SpaceAgent | null>(null);
	const [deletingAgent, setDeletingAgent] = useState<SpaceAgent | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);

	// Drift detection: set of agent IDs that have drifted from their preset.
	// Empty until the first successful drift report fetch — agents not in the
	// set render without the badge or sync button (the safe default when the
	// daemon hasn't responded yet).
	const [driftedAgentIds, setDriftedAgentIds] = useState<Set<string>>(new Set());
	const [syncingAgentId, setSyncingAgentId] = useState<string | null>(null);

	// Re-fetch drift report whenever the agent set changes. We watch a
	// concatenated key of (id, updatedAt) so the effect fires for adds,
	// removes, and edits — but not for unrelated re-renders.
	const driftKey = agents
		.map((a) => `${a.id}:${a.updatedAt}`)
		.sort()
		.join('|');

	useEffect(() => {
		if (!spaceId) return;
		const hub = connectionManager.getHubIfConnected();
		if (!hub) return;

		let cancelled = false;
		hub
			.request<{ report: AgentDriftReport }>('spaceAgent.getDriftReport', { spaceId })
			.then((result) => {
				if (cancelled) return;
				const ids = new Set<string>();
				for (const entry of result.report.agents) {
					if (entry.drifted) ids.add(entry.agentId);
				}
				setDriftedAgentIds(ids);
			})
			.catch(() => {
				// Drift detection is best-effort — silently swallow errors so
				// list rendering never depends on the report succeeding.
			});

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- driftKey captures the list identity
	}, [spaceId, driftKey]);

	const handleSync = async (agent: SpaceAgent) => {
		if (!spaceId) return;
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Connection lost.');
			return;
		}
		setSyncingAgentId(agent.id);
		try {
			await hub.request('spaceAgent.syncFromTemplate', {
				spaceId,
				agentId: agent.id,
			});
			// Clear drift state for this agent eagerly so the badge disappears
			// before the next refresh cycle. The spaceAgent.updated event will
			// re-trigger the effect and reconcile authoritatively.
			setDriftedAgentIds((prev) => {
				const next = new Set(prev);
				next.delete(agent.id);
				return next;
			});
			toast.success(`"${agent.name}" synced from template`);
		} catch (err) {
			toast.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setSyncingAgentId((current) => (current === agent.id ? null : current));
		}
	};

	function getWorkflowNamesReferencingAgent(agentId: string): string[] {
		return workflows
			.filter((wf) => wf.nodes.some((step) => step.agents.some((a) => a.agentId === agentId)))
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

	const existingAgentNames = agents.filter((a) => a.id !== editingAgent?.id).map((a) => a.name);

	if (loading) {
		return (
			<div class="h-full overflow-y-auto">
				<div class="min-h-[calc(100%+1px)] flex items-center justify-center">
					<span class="text-xs text-gray-600 animate-pulse">Loading agents...</span>
				</div>
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

			{/* Built-in Task Agent */}
			{space && (
				<div class="mb-4">
					<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
						Built-in
					</h3>
					<TaskAgentCard
						spaceId={space.id}
						taskAgentConfig={space.taskAgentConfig}
						defaultModel={space.defaultModel}
					/>
				</div>
			)}

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
				<div class="flex-1 overflow-y-auto">
					<div class="min-h-[calc(100%+1px)] space-y-2">
						{space && (
							<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
								Custom Agents
							</h3>
						)}
						{agents.map((agent) => (
							<AgentCard
								key={agent.id}
								agent={agent}
								drifted={driftedAgentIds.has(agent.id)}
								syncing={syncingAgentId === agent.id}
								onEdit={handleEdit}
								onDelete={handleDeleteClick}
								onSync={handleSync}
							/>
						))}
					</div>
				</div>
			)}

			{/* Editor Modal */}
			{editorOpen && (
				<SpaceAgentEditor
					agent={editingAgent}
					existingAgentNames={existingAgentNames}
					onSave={handleEditorClose}
					onCancel={handleEditorClose}
				/>
			)}

			{/* Blocked delete: agent is still referenced by one or more workflows */}
			{deletingAgent && referencedWorkflows.length > 0 && (
				<Modal isOpen onClose={() => setDeletingAgent(null)} title="Cannot Delete Agent" size="sm">
					<div class="space-y-4">
						<p class="text-sm text-gray-300 leading-relaxed">
							<span class="font-medium text-gray-100">"{deletingAgent.name}"</span> is currently
							used in the following {referencedWorkflows.length === 1 ? 'workflow' : 'workflows'}:
						</p>
						<ul class="list-disc list-inside space-y-1">
							{referencedWorkflows.map((name) => (
								<li key={name} class="text-sm text-amber-300">
									{name}
								</li>
							))}
						</ul>
						<p class="text-xs text-gray-500">
							Remove this agent from all workflow steps first, then delete it.
						</p>
						<div class="flex justify-end pt-1">
							<button
								type="button"
								onClick={() => setDeletingAgent(null)}
								class="px-4 py-2 text-sm font-medium text-gray-200 bg-dark-700 hover:bg-dark-600 rounded-lg transition-colors"
							>
								Understood
							</button>
						</div>
					</div>
				</Modal>
			)}

			{/* Standard delete confirmation: agent is not referenced by any workflow */}
			{deletingAgent && referencedWorkflows.length === 0 && (
				<ConfirmModal
					isOpen
					onClose={() => {
						setDeletingAgent(null);
						setDeleteError(null);
					}}
					onConfirm={handleDeleteConfirm}
					title="Delete Agent"
					message={`Are you sure you want to delete "${deletingAgent.name}"? This action cannot be undone.`}
					confirmText="Delete"
					confirmButtonVariant="danger"
					isLoading={deleting}
					error={deleteError}
				/>
			)}
		</div>
	);
}
