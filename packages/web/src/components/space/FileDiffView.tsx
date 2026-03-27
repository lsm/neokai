/**
 * FileDiffView — syntax-highlighted unified diff viewer
 *
 * Fetches the diff for a single file from the worktree via
 * `spaceWorkflowRun.getFileDiff` and renders it line-by-line with:
 *   - Green rows for additions (+)
 *   - Red rows for removals (-)
 *   - Blue rows for hunk headers (@@)
 *   - Dual line-number columns (old / new)
 */

import { useState, useEffect } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { cn } from '../../lib/utils';

// ============================================================================
// Types
// ============================================================================

export interface FileDiffViewProps {
	runId: string;
	filePath: string;
	onBack: () => void;
	class?: string;
}

type DiffLineType = 'header' | 'index' | 'file-header' | 'hunk' | 'added' | 'removed' | 'context';

interface ParsedLine {
	type: DiffLineType;
	content: string;
	oldLineNum: number | null;
	newLineNum: number | null;
}

// ============================================================================
// Diff parser
// ============================================================================

/**
 * Parse a unified diff string into typed, line-numbered rows.
 *
 * Handles:
 *   diff --git  → header
 *   index ...   → index
 *   --- / +++   → file-header
 *   @@ ...      → hunk (resets line counters)
 *   -           → removed (increments old counter)
 *   +           → added   (increments new counter)
 *   (space)     → context (increments both)
 */
export function parseDiff(diff: string): ParsedLine[] {
	if (!diff) return [];

	const result: ParsedLine[] = [];
	let oldLine = 0;
	let newLine = 0;

	for (const raw of diff.split('\n')) {
		if (raw.startsWith('diff --git')) {
			result.push({ type: 'header', content: raw, oldLineNum: null, newLineNum: null });
		} else if (
			raw.startsWith('index ') ||
			raw.startsWith('new file') ||
			raw.startsWith('deleted file') ||
			raw.startsWith('old mode') ||
			raw.startsWith('new mode') ||
			raw.startsWith('similarity index') ||
			raw.startsWith('rename from') ||
			raw.startsWith('rename to') ||
			raw.startsWith('copy from') ||
			raw.startsWith('copy to')
		) {
			result.push({ type: 'index', content: raw, oldLineNum: null, newLineNum: null });
		} else if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
			result.push({ type: 'file-header', content: raw, oldLineNum: null, newLineNum: null });
		} else if (raw.startsWith('@@ ')) {
			const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (m) {
				oldLine = parseInt(m[1], 10) - 1;
				newLine = parseInt(m[2], 10) - 1;
			}
			result.push({ type: 'hunk', content: raw, oldLineNum: null, newLineNum: null });
		} else if (raw.startsWith('+')) {
			newLine++;
			result.push({ type: 'added', content: raw.slice(1), oldLineNum: null, newLineNum: newLine });
		} else if (raw.startsWith('-')) {
			oldLine++;
			result.push({
				type: 'removed',
				content: raw.slice(1),
				oldLineNum: oldLine,
				newLineNum: null,
			});
		} else if (raw.startsWith('\\')) {
			// "\ No newline at end of file" — informational; no line number increment
			result.push({ type: 'index', content: raw, oldLineNum: null, newLineNum: null });
		} else {
			// context line (starts with space) or empty
			oldLine++;
			newLine++;
			result.push({
				type: 'context',
				content: raw.startsWith(' ') ? raw.slice(1) : raw,
				oldLineNum: oldLine,
				newLineNum: newLine,
			});
		}
	}

	return result;
}

// ============================================================================
// Component
// ============================================================================

export function FileDiffView({ runId, filePath, onBack, class: className }: FileDiffViewProps) {
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [diffText, setDiffText] = useState<string | null>(null);
	const [additions, setAdditions] = useState(0);
	const [deletions, setDeletions] = useState(0);

	useEffect(() => {
		setLoading(true);
		setError(null);
		setDiffText(null);

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			setError('Not connected');
			setLoading(false);
			return;
		}

		hub
			.request<{ diff: string; additions: number; deletions: number; filePath: string }>(
				'spaceWorkflowRun.getFileDiff',
				{ runId, filePath }
			)
			.then((result) => {
				setDiffText(result.diff);
				setAdditions(result.additions);
				setDeletions(result.deletions);
			})
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : 'Failed to load diff');
			})
			.finally(() => setLoading(false));
	}, [runId, filePath]);

	const parsedLines = diffText ? parseDiff(diffText) : [];

	return (
		<div class={cn('flex flex-col h-full overflow-hidden', className)} data-testid="file-diff-view">
			{/* Header bar */}
			<div class="flex items-center gap-3 px-4 py-3 border-b border-dark-700 flex-shrink-0 bg-dark-850">
				<button
					onClick={onBack}
					class="text-gray-400 hover:text-gray-100 transition-colors flex-shrink-0"
					aria-label="Back to file list"
					data-testid="file-diff-back"
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M15 19l-7-7 7-7"
						/>
					</svg>
				</button>
				<p class="flex-1 text-xs font-mono text-gray-200 truncate min-w-0" title={filePath}>
					{filePath}
				</p>
				{!loading && !error && (
					<div class="flex items-center gap-2 text-xs font-mono flex-shrink-0">
						<span class="text-green-400" data-testid="diff-additions">
							+{additions}
						</span>
						<span class="text-red-400" data-testid="diff-deletions">
							-{deletions}
						</span>
					</div>
				)}
			</div>

			{/* Content area */}
			<div class="flex-1 overflow-auto">
				{loading && (
					<div class="flex items-center justify-center h-32" data-testid="diff-loading">
						<div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
					</div>
				)}

				{error && (
					<div class="px-4 py-4" data-testid="diff-error">
						<p class="text-sm text-red-400">{error}</p>
					</div>
				)}

				{!loading && !error && diffText !== null && parsedLines.length === 0 && (
					<div class="px-4 py-6 text-center" data-testid="diff-empty">
						<p class="text-sm text-gray-500">No changes in this file</p>
					</div>
				)}

				{!loading && !error && parsedLines.length > 0 && (
					<table
						class="w-full text-xs font-mono border-collapse"
						style={{ tableLayout: 'fixed' }}
						data-testid="diff-table"
					>
						<colgroup>
							<col style={{ width: '3.5rem' }} />
							<col style={{ width: '3.5rem' }} />
							<col />
						</colgroup>
						<tbody>
							{parsedLines.map((line, idx) => {
								let rowClass = '';
								let contentClass = 'text-gray-300';
								let sigil: string | null = null;

								switch (line.type) {
									case 'added':
										rowClass = 'bg-green-950/40';
										contentClass = 'text-green-300';
										sigil = '+';
										break;
									case 'removed':
										rowClass = 'bg-red-950/40';
										contentClass = 'text-red-300';
										sigil = '-';
										break;
									case 'hunk':
										rowClass = 'bg-blue-950/30';
										contentClass = 'text-blue-400';
										break;
									case 'header':
										rowClass = 'bg-dark-800';
										contentClass = 'text-gray-400';
										break;
									case 'file-header':
									case 'index':
										rowClass = 'bg-dark-850';
										contentClass = 'text-gray-500';
										break;
									default:
										break;
								}

								return (
									<tr key={idx} class={rowClass}>
										<td class="px-2 py-0.5 text-gray-600 text-right select-none border-r border-dark-700 w-14">
											{line.oldLineNum ?? ''}
										</td>
										<td class="px-2 py-0.5 text-gray-600 text-right select-none border-r border-dark-700 w-14">
											{line.newLineNum ?? ''}
										</td>
										<td class={cn('px-3 py-0.5 whitespace-pre overflow-hidden', contentClass)}>
											{sigil !== null && (
												<span
													class={cn(
														'mr-1 select-none',
														sigil === '+' ? 'text-green-600' : 'text-red-600'
													)}
												>
													{sigil}
												</span>
											)}
											{line.content}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
