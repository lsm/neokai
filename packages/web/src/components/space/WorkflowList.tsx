/**
 * WorkflowList — displays workflow definitions in a Space, with per-workflow
 * export and list-level Export All / Import actions.
 */

import { useState } from 'preact/hooks';
import type { SpaceWorkflow, SpaceExportBundle } from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { ImportPreviewDialog } from './ImportPreviewDialog.tsx';
import type { ImportPreviewResult, ImportConflictResolution } from './ImportPreviewDialog.tsx';
import { downloadBundle, pickImportFile } from './export-import-utils.ts';

interface WorkflowListProps {
	spaceId: string;
	spaceName: string;
	workflows: SpaceWorkflow[];
}

export function WorkflowList({ spaceId, spaceName, workflows }: WorkflowListProps) {
	const [importBundle, setImportBundle] = useState<SpaceExportBundle | null>(null);
	const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null);
	const [isExecuting, setIsExecuting] = useState(false);

	// ─── Export helpers ──────────────────────────────────────────────────────

	async function exportWorkflow(workflow: SpaceWorkflow) {
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

	// ─── Import helpers ──────────────────────────────────────────────────────

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

			const createdAgents = result.agents.filter((a) => a.action !== 'skipped').length;
			const createdWorkflows = result.workflows.filter((w) => w.action !== 'skipped').length;
			const parts: string[] = [];
			if (createdAgents > 0) parts.push(`${createdAgents} agent${createdAgents === 1 ? '' : 's'}`);
			if (createdWorkflows > 0)
				parts.push(`${createdWorkflows} workflow${createdWorkflows === 1 ? '' : 's'}`);
			toast.success(parts.length > 0 ? `Imported ${parts.join(' and ')}` : 'Nothing imported');
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

	// ─── Render ─────────────────────────────────────────────────────────────

	return (
		<div class="flex flex-col h-full">
			{/* Toolbar */}
			<div class="flex items-center justify-between px-4 py-3 border-b border-dark-700">
				<h2 class="text-sm font-semibold text-gray-200">
					Workflows <span class="ml-1 text-xs text-gray-500 font-normal">({workflows.length})</span>
				</h2>
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
				</div>
			</div>

			{/* List */}
			<div class="flex-1 overflow-y-auto">
				{workflows.length === 0 ? (
					<div class="flex flex-col items-center justify-center p-10 text-center">
						<div class="text-3xl mb-3">⚡</div>
						<p class="text-sm text-gray-400">No workflows yet</p>
						<p class="text-xs text-gray-500 mt-1">Create workflows or import from a file</p>
					</div>
				) : (
					<ul class="divide-y divide-dark-700/50">
						{workflows.map((workflow) => (
							<li key={workflow.id} class="flex items-center justify-between px-4 py-3 group">
								<div class="min-w-0">
									<p class="text-sm font-medium text-gray-200 truncate">{workflow.name}</p>
									<div class="flex items-center gap-2 mt-0.5">
										<span class="text-xs text-gray-500">
											{workflow.steps.length} step{workflow.steps.length === 1 ? '' : 's'}
										</span>
										{workflow.tags.length > 0 && (
											<div class="flex gap-1">
												{workflow.tags.slice(0, 2).map((tag) => (
													<span
														key={tag}
														class="text-xs bg-dark-700 text-gray-400 px-1.5 py-0.5 rounded"
													>
														{tag}
													</span>
												))}
											</div>
										)}
									</div>
									{workflow.description && (
										<p class="text-xs text-gray-500 mt-0.5 truncate">{workflow.description}</p>
									)}
								</div>
								<button
									type="button"
									onClick={() => exportWorkflow(workflow)}
									class="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-100 hover:bg-dark-800 rounded transition-all"
									title="Export workflow"
								>
									<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
										/>
									</svg>
									Export
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* Import Preview Dialog — key on exportedAt so state resets for each new bundle */}
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
