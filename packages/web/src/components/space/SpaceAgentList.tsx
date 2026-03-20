/**
 * SpaceAgentList — displays agents configured in a Space, with per-agent
 * export and list-level Export All / Import actions.
 */

import { useState } from 'preact/hooks';
import type { SpaceAgent, SpaceExportBundle } from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { ImportPreviewDialog } from './ImportPreviewDialog.tsx';
import type { ImportPreviewResult, ImportConflictResolution } from './ImportPreviewDialog.tsx';
import { downloadBundle, pickImportFile } from './export-import-utils.ts';

interface SpaceAgentListProps {
	spaceId: string;
	spaceName: string;
	agents: SpaceAgent[];
}

export function SpaceAgentList({ spaceId, spaceName, agents }: SpaceAgentListProps) {
	const [importBundle, setImportBundle] = useState<SpaceExportBundle | null>(null);
	const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null);
	const [isExecuting, setIsExecuting] = useState(false);

	// ─── Export helpers ──────────────────────────────────────────────────────

	async function exportAgent(agent: SpaceAgent) {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Connection lost.');
			return;
		}
		try {
			const { bundle } = await hub.request<{ bundle: SpaceExportBundle }>('spaceExport.agents', {
				spaceId,
				agentIds: [agent.id],
			});
			downloadBundle(bundle, spaceName, 'agents');
			toast.success(`Exported "${agent.name}"`);
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
			const { bundle } = await hub.request<{ bundle: SpaceExportBundle }>('spaceExport.agents', {
				spaceId,
			});
			downloadBundle(bundle, spaceName, 'agents');
			toast.success(`Exported ${agents.length} agent${agents.length === 1 ? '' : 's'}`);
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

			const created = result.agents.filter((a) => a.action !== 'skipped').length;
			toast.success(`Imported ${created} agent${created === 1 ? '' : 's'}`);
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
					Agents <span class="ml-1 text-xs text-gray-500 font-normal">({agents.length})</span>
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
					{agents.length > 0 && (
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
				{agents.length === 0 ? (
					<div class="flex flex-col items-center justify-center p-10 text-center">
						<div class="text-3xl mb-3">🤖</div>
						<p class="text-sm text-gray-400">No agents yet</p>
						<p class="text-xs text-gray-500 mt-1">Create agents or import from a file</p>
					</div>
				) : (
					<ul class="divide-y divide-dark-700/50">
						{agents.map((agent) => (
							<li key={agent.id} class="flex items-center justify-between px-4 py-3 group">
								<div class="min-w-0">
									<p class="text-sm font-medium text-gray-200 truncate">{agent.name}</p>
									<div class="flex items-center gap-2 mt-0.5">
										<span class="text-xs text-gray-500 capitalize">{agent.role}</span>
										{agent.model && (
											<span class="text-xs text-gray-600 font-mono">{agent.model}</span>
										)}
									</div>
									{agent.description && (
										<p class="text-xs text-gray-500 mt-0.5 truncate">{agent.description}</p>
									)}
								</div>
								<button
									type="button"
									onClick={() => exportAgent(agent)}
									class="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-100 hover:bg-dark-800 rounded transition-all"
									title="Export agent"
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

			{/* Import Preview Dialog */}
			{importPreview && importBundle && (
				<ImportPreviewDialog
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
