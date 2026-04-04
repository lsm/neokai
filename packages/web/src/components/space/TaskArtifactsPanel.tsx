/**
 * TaskArtifactsPanel — right-side slide-over showing all changed files
 * for a task's workflow run.
 *
 * Fetches `spaceWorkflowRun.getGateArtifacts` using the task's workflowRunId
 * and renders:
 *   - Diff summary: N files, +additions, -deletions
 *   - Clickable file list with per-file +/- counts
 *   - FileDiffView on click
 */

import { useState, useEffect } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { cn } from '../../lib/utils';
import { FileDiffView } from './FileDiffView';

// ============================================================================
// Types
// ============================================================================

export interface TaskArtifactsPanelProps {
	/** Workflow run ID (from task.workflowRunId) */
	runId: string;
	/** Called when the panel should close */
	onClose: () => void;
	class?: string;
}

interface FileDiffStat {
	path: string;
	additions: number;
	deletions: number;
}

interface ArtifactsResult {
	files: FileDiffStat[];
	totalAdditions: number;
	totalDeletions: number;
	worktreePath?: string;
	baseRef?: string;
}

// ============================================================================
// Component
// ============================================================================

export function TaskArtifactsPanel({ runId, onClose, class: className }: TaskArtifactsPanelProps) {
	const [loading, setLoading] = useState(true);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [artifacts, setArtifacts] = useState<ArtifactsResult | null>(null);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);

	useEffect(() => {
		setLoading(true);
		setFetchError(null);
		setArtifacts(null);
		setSelectedFile(null);

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			setFetchError('Not connected');
			setLoading(false);
			return;
		}

		hub
			.request<ArtifactsResult>('spaceWorkflowRun.getGateArtifacts', { runId })
			.then((result) => setArtifacts(result))
			.catch((err: unknown) => {
				setFetchError(err instanceof Error ? err.message : 'Failed to load artifacts');
			})
			.finally(() => setLoading(false));
	}, [runId]);

	// If a file is selected, swap to diff view
	if (selectedFile) {
		return (
			<FileDiffView
				runId={runId}
				filePath={selectedFile}
				onBack={() => setSelectedFile(null)}
				class={className}
			/>
		);
	}

	return (
		<div
			class={cn('flex flex-col h-full overflow-hidden', className)}
			data-testid="artifacts-panel"
		>
			{/* Header */}
			<div class="flex items-center justify-between px-4 py-3 border-b border-dark-700 flex-shrink-0 bg-dark-850">
				<div>
					<h2 class="text-sm font-semibold text-gray-100">Artifacts</h2>
					<p class="text-xs text-gray-500 mt-0.5">Changed files across this workflow run</p>
				</div>
				<button
					onClick={onClose}
					class="text-gray-600 hover:text-gray-400 transition-colors flex-shrink-0 ml-3"
					aria-label="Close artifacts panel"
					data-testid="artifacts-panel-close"
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</button>
			</div>

			{/* Scrollable body */}
			<div class="flex-1 overflow-y-auto min-h-0">
				{/* Loading */}
				{loading && (
					<div class="flex items-center justify-center h-32" data-testid="artifacts-loading">
						<div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
					</div>
				)}

				{/* Fetch error */}
				{fetchError && !loading && (
					<div class="px-4 py-4" data-testid="artifacts-error">
						<p class="text-sm text-red-400">{fetchError}</p>
					</div>
				)}

				{/* Artifacts content */}
				{!loading && !fetchError && artifacts && (
					<div class="p-4 space-y-4">
						{/* Diff summary */}
						<div class="flex items-center gap-4 text-xs" data-testid="artifacts-summary">
							<span class="text-gray-400">
								{artifacts.files.length} {artifacts.files.length === 1 ? 'file' : 'files'} changed
							</span>
							<span class="text-green-400 font-mono">+{artifacts.totalAdditions}</span>
							<span class="text-red-400 font-mono">-{artifacts.totalDeletions}</span>
						</div>

						{/* File list */}
						{artifacts.files.length === 0 ? (
							<p class="text-sm text-gray-500" data-testid="artifacts-no-files">
								No changed files found
							</p>
						) : (
							<div class="space-y-0.5" data-testid="artifacts-file-list">
								{artifacts.files.map((file) => (
									<button
										key={file.path}
										onClick={() => setSelectedFile(file.path)}
										class={cn(
											'w-full flex items-center gap-3 px-3 py-2 rounded text-left',
											'hover:bg-dark-700 transition-colors group'
										)}
										data-testid={`artifacts-file-${file.path}`}
									>
										{/* File icon */}
										<svg
											class="w-3.5 h-3.5 text-gray-500 flex-shrink-0"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
											/>
										</svg>
										{/* Path */}
										<span
											class="flex-1 text-xs font-mono text-gray-300 truncate min-w-0 group-hover:text-gray-100"
											title={file.path}
										>
											{file.path}
										</span>
										{/* Stats */}
										<span class="flex-shrink-0 flex items-center gap-1.5 text-xs font-mono">
											<span class="text-green-400">+{file.additions}</span>
											<span class="text-red-400">-{file.deletions}</span>
										</span>
										{/* Chevron */}
										<svg
											class="w-3 h-3 text-gray-600 flex-shrink-0 group-hover:text-gray-400"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M9 5l7 7-7 7"
											/>
										</svg>
									</button>
								))}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
