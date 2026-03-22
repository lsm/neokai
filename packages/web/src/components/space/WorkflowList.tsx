/**
 * WorkflowList Component
 *
 * Displays all workflows in the space with:
 * - Workflow cards: name, description, step count, tag chips
 * - Mini step visualization (horizontal dots showing step sequence)
 * - "Create Workflow" button and template options
 * - Edit, Delete, and Export actions per card
 * - Import and Export All toolbar actions
 * - Real-time updates via SpaceStore
 */

import { useState } from 'preact/hooks';
import type { SpaceWorkflow, SpaceExportBundle, WorkflowConditionType } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { ImportPreviewDialog } from './ImportPreviewDialog.tsx';
import type { ImportPreviewResult, ImportConflictResolution } from './ImportPreviewDialog.tsx';
import { downloadBundle, pickImportFile } from './export-import-utils.ts';

// ============================================================================
// Mini Step Visualization
// ============================================================================

const GATE_COLORS: Record<WorkflowConditionType, string> = {
	always: 'bg-blue-500',
	human: 'bg-yellow-400',
	condition: 'bg-purple-400',
	task_result: 'bg-orange-500',
};

function MiniStepDot({ isStart }: { isStart: boolean }) {
	return (
		<span
			class={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isStart ? 'bg-blue-500' : 'bg-blue-400'}`}
		/>
	);
}

function MiniConnector({ conditionType }: { conditionType?: WorkflowConditionType }) {
	const color = conditionType ? GATE_COLORS[conditionType] : 'bg-gray-700';
	return (
		<div class="flex items-center gap-0.5 flex-shrink-0">
			<div class="w-4 h-px bg-gray-700" />
			{conditionType && conditionType !== 'always' && (
				<span class={`w-1.5 h-1.5 rounded-full ${color}`} />
			)}
			<div class="w-4 h-px bg-gray-700" />
		</div>
	);
}

// Show at most MAX_DOTS dots; if there are more steps, show a "+N" overflow label.
const MAX_DOTS = 6;

function MiniStepViz({ workflow }: { workflow: SpaceWorkflow }) {
	if (workflow.steps.length === 0) {
		return <span class="text-xs text-gray-700 italic">No steps</span>;
	}

	// Build ordered step list following startStepId
	const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));
	const ordered: string[] = [];
	const visited = new Set<string>();
	let currentId: string | undefined = workflow.startStepId;

	while (currentId && !visited.has(currentId)) {
		visited.add(currentId);
		ordered.push(currentId);
		const outgoing = workflow.transitions
			.filter((t) => t.from === currentId)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		currentId = outgoing[0]?.to;
	}

	// Append orphaned steps (not reachable from startStepId)
	for (const s of workflow.steps) {
		if (!visited.has(s.id)) {
			ordered.push(s.id);
		}
	}

	// Cap display at MAX_DOTS; show overflow count if needed
	const overflow = ordered.length > MAX_DOTS ? ordered.length - MAX_DOTS : 0;
	const display = overflow > 0 ? ordered.slice(0, MAX_DOTS) : ordered;

	return (
		<div class="flex items-center gap-0 overflow-hidden">
			{display.map((id, i) => {
				const step = stepMap.get(id);
				const nextId = i + 1 < display.length ? display[i + 1] : undefined;
				const transition = nextId
					? workflow.transitions.find((t) => t.from === id && t.to === nextId)
					: undefined;

				return (
					<div key={id} class="flex items-center" title={step?.name ?? id}>
						<MiniStepDot isStart={i === 0} />
						{nextId && <MiniConnector conditionType={transition?.condition?.type} />}
					</div>
				);
			})}
			{overflow > 0 && <span class="text-xs text-gray-600 ml-1">+{overflow}</span>}
		</div>
	);
}

// ============================================================================
// Workflow Card
// ============================================================================

interface WorkflowCardProps {
	workflow: SpaceWorkflow;
	spaceId: string;
	spaceName: string;
	onEdit: () => void;
}

function WorkflowCard({ workflow, spaceId, spaceName, onEdit }: WorkflowCardProps) {
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	async function handleDelete() {
		setDeleting(true);
		setDeleteError(null);
		try {
			await spaceStore.deleteWorkflow(workflow.id);
		} catch (err) {
			setDeleteError(err instanceof Error ? err.message : 'Failed to delete workflow.');
			setDeleting(false);
			setConfirmDelete(false);
		}
	}

	async function handleExport() {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Connection lost.');
			return;
		}
		try {
			const { bundle } = await hub.request<{ bundle: SpaceExportBundle }>('spaceExport.workflows', {
				spaceId,
				workflowIds: [workflow.id],
			});
			downloadBundle(bundle, spaceName, 'workflows');
			toast.success(`Exported "${workflow.name}"`);
		} catch (err) {
			toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-4 hover:border-dark-600 transition-colors group">
			{deleteError && (
				<div class="mb-2 px-3 py-1.5 bg-red-900/20 border border-red-800/40 rounded text-xs text-red-300">
					{deleteError}
				</div>
			)}

			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<h3 class="text-sm font-medium text-gray-200 truncate">{workflow.name}</h3>
					{workflow.description && (
						<p class="text-xs text-gray-500 mt-0.5 line-clamp-2">{workflow.description}</p>
					)}
				</div>

				{/* Action buttons */}
				<div
					data-testid="workflow-card-actions"
					class="flex items-center gap-1.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
				>
					{confirmDelete ? (
						<>
							<span class="text-xs text-red-400">Delete?</span>
							<button
								onClick={handleDelete}
								disabled={deleting}
								class="px-2 py-1 text-xs text-red-300 bg-red-900/30 hover:bg-red-900/50 border border-red-800/50 rounded disabled:opacity-50 transition-colors"
							>
								{deleting ? '…' : 'Confirm'}
							</button>
							<button
								onClick={() => setConfirmDelete(false)}
								class="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
							>
								Cancel
							</button>
						</>
					) : (
						<>
							<button
								onClick={onEdit}
								class="px-2.5 py-1 text-xs text-gray-500 hover:text-gray-200 bg-dark-800 hover:bg-dark-700 rounded border border-dark-600 hover:border-dark-500 transition-colors"
							>
								Edit
							</button>
							<button
								onClick={handleExport}
								class="px-2.5 py-1 text-xs text-gray-500 hover:text-gray-200 bg-dark-800 hover:bg-dark-700 rounded border border-dark-600 hover:border-dark-500 transition-colors"
								title="Export workflow"
							>
								<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
									/>
								</svg>
							</button>
							<button
								onClick={() => setConfirmDelete(true)}
								class="px-2.5 py-1 text-xs text-gray-500 hover:text-red-400 bg-dark-800 hover:bg-dark-700 rounded border border-dark-600 hover:border-dark-500 transition-colors"
								title="Delete workflow"
							>
								<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
									/>
								</svg>
							</button>
						</>
					)}
				</div>
			</div>

			{/* Mini step viz */}
			<div class="mt-3">
				<MiniStepViz workflow={workflow} />
			</div>

			{/* Step count + tags footer */}
			<div class="mt-2.5 flex items-center gap-2 flex-wrap">
				<span class="text-xs text-gray-600">
					{workflow.steps.length} {workflow.steps.length === 1 ? 'step' : 'steps'}
				</span>
				{workflow.tags.length > 0 && (
					<>
						<span class="text-gray-700">·</span>
						{workflow.tags.map((tag) => (
							<span
								key={tag}
								class="px-1.5 py-0.5 text-xs bg-dark-800 border border-dark-700 rounded text-gray-500"
							>
								{tag}
							</span>
						))}
					</>
				)}
			</div>
		</div>
	);
}

// ============================================================================
// Main Component
// ============================================================================

interface WorkflowListProps {
	spaceId: string;
	spaceName: string;
	workflows: SpaceWorkflow[];
	onCreateWorkflow: () => void;
	onEditWorkflow: (workflowId: string) => void;
}

export function WorkflowList({
	spaceId,
	spaceName,
	workflows,
	onCreateWorkflow,
	onEditWorkflow,
}: WorkflowListProps) {
	const loading = spaceStore.loading.value;
	const [importBundle, setImportBundle] = useState<SpaceExportBundle | null>(null);
	const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null);
	const [isExecuting, setIsExecuting] = useState(false);

	// ─── Import/Export helpers ──────────────────────────────────────────────

	async function exportAll() {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Connection lost.');
			return;
		}
		try {
			const { bundle } = await hub.request<{ bundle: SpaceExportBundle }>('spaceExport.workflows', {
				spaceId,
			});
			downloadBundle(bundle, spaceName, 'workflows');
			toast.success(`Exported ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`);
		} catch (err) {
			toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function startImport() {
		const bundle = await pickImportFile();
		if (!bundle) return;

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Connection lost.');
			return;
		}
		try {
			const preview = await hub.request<ImportPreviewResult>('spaceImport.preview', {
				spaceId,
				bundle,
			});
			setImportBundle(bundle);
			setImportPreview(preview);
		} catch (err) {
			toast.error(`Preview failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function executeImport(resolution: ImportConflictResolution) {
		if (!importBundle) return;
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Connection lost.');
			return;
		}
		setIsExecuting(true);
		try {
			const result = await hub.request<{
				agents: Array<{ name: string; id: string; action: string }>;
				workflows: Array<{ name: string; id: string; action: string }>;
				warnings: string[];
			}>('spaceImport.execute', { spaceId, bundle: importBundle, conflictResolution: resolution });

			const createdWorkflows = result.workflows.filter((w) => w.action !== 'skipped').length;
			toast.success(
				createdWorkflows > 0
					? `Imported ${createdWorkflows} workflow${createdWorkflows === 1 ? '' : 's'}`
					: 'Nothing imported'
			);
			if (result.warnings.length) {
				toast.warning(result.warnings[0]);
			}
			setImportBundle(null);
			setImportPreview(null);
		} catch (err) {
			toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setIsExecuting(false);
		}
	}

	if (loading) {
		return (
			<div class="flex items-center justify-center h-32">
				<div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
			</div>
		);
	}

	return (
		<div class="flex flex-col h-full overflow-hidden">
			{/* Header */}
			<div class="flex items-center justify-between px-6 py-4 border-b border-dark-700 flex-shrink-0">
				<h1 class="text-sm font-semibold text-gray-100">
					Workflows <span class="text-xs text-gray-500 font-normal">({workflows.length})</span>
				</h1>
				<div class="flex items-center gap-2">
					<button
						type="button"
						onClick={startImport}
						class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-300 hover:text-gray-100 hover:bg-dark-800 rounded-lg transition-colors"
					>
						<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
							/>
						</svg>
						Import
					</button>
					{workflows.length > 0 && (
						<button
							type="button"
							onClick={exportAll}
							class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-300 hover:text-gray-100 hover:bg-dark-800 rounded-lg transition-colors"
						>
							<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
								/>
							</svg>
							Export All
						</button>
					)}
					<button
						onClick={onCreateWorkflow}
						class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
					>
						<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M12 4v16m8-8H4"
							/>
						</svg>
						Create Workflow
					</button>
				</div>
			</div>

			{/* List */}
			<div class="flex-1 overflow-y-auto p-6">
				{workflows.length === 0 ? (
					<div class="text-center py-12">
						<div class="w-10 h-10 mx-auto mb-3 rounded-lg bg-dark-800 border border-dark-700 flex items-center justify-center">
							<svg
								class="w-5 h-5 text-gray-600"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M4 6h16M4 10h16M4 14h16M4 18h16"
								/>
							</svg>
						</div>
						<p class="text-sm text-gray-500">No workflows yet</p>
						<p class="text-xs text-gray-600 mt-1">
							Create a workflow to define multi-agent pipelines.
						</p>
						<button
							onClick={onCreateWorkflow}
							class="mt-4 px-4 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
						>
							Create your first workflow
						</button>
					</div>
				) : (
					<div class="space-y-3">
						{workflows.map((wf) => (
							<WorkflowCard
								key={wf.id}
								workflow={wf}
								spaceId={spaceId}
								spaceName={spaceName}
								onEdit={() => onEditWorkflow(wf.id)}
							/>
						))}
					</div>
				)}
			</div>

			{/* Import Preview Dialog */}
			{importPreview && importBundle && (
				<ImportPreviewDialog
					key={importBundle.exportedAt}
					isOpen={true}
					onClose={() => {
						setImportBundle(null);
						setImportPreview(null);
					}}
					onConfirm={executeImport}
					preview={importPreview}
					bundle={importBundle}
					isExecuting={isExecuting}
				/>
			)}
		</div>
	);
}
