/**
 * NeoActivityView
 *
 * Scrollable list of Neo's past actions from neoStore.activity.
 * Each entry shows: timestamp, tool name, target description, status, outcome.
 * Click to expand for full details.
 */

import { useState } from 'preact/hooks';
import { neoStore, type NeoActivityEntry } from '../../lib/neo-store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(isoString: string): string {
	try {
		const date = new Date(isoString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffSecs = Math.floor(diffMs / 1000);
		const diffMins = Math.floor(diffSecs / 60);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffSecs < 60) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	} catch {
		return isoString;
	}
}

/** Format tool_name → "Tool Name" */
function formatToolName(toolName: string): string {
	return toolName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Try to extract a human-readable target description from JSON input. */
function extractTarget(entry: NeoActivityEntry): string {
	if (entry.targetType && entry.targetId) {
		return `${entry.targetType} ${entry.targetId}`;
	}
	if (entry.input) {
		try {
			const parsed = JSON.parse(entry.input) as Record<string, unknown>;
			// Look for common naming fields
			const name =
				parsed['name'] ??
				parsed['title'] ??
				parsed['id'] ??
				parsed['roomId'] ??
				parsed['spaceId'] ??
				parsed['goalId'] ??
				parsed['taskId'];
			if (typeof name === 'string' && name.length > 0) return name;
		} catch {
			/* ignore */
		}
	}
	return '';
}

/** Extract outcome summary from JSON output string. */
function extractOutcome(entry: NeoActivityEntry): string {
	if (entry.error) return entry.error;
	if (!entry.output) return '';
	try {
		const parsed = JSON.parse(entry.output) as Record<string, unknown>;
		if (typeof parsed['summary'] === 'string') return parsed['summary'];
		if (typeof parsed['message'] === 'string') return parsed['message'];
		if (typeof parsed['error'] === 'string') return parsed['error'];
	} catch {
		if (entry.output.length < 120) return entry.output;
	}
	return '';
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: NeoActivityEntry['status'] }) {
	if (status === 'success') {
		return (
			<span
				data-testid="activity-status-success"
				class="inline-flex items-center gap-1 text-xs text-green-400"
			>
				<svg
					class="w-3 h-3"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2.5}
					aria-hidden="true"
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
				</svg>
				Done
			</span>
		);
	}
	if (status === 'error') {
		return (
			<span
				data-testid="activity-status-error"
				class="inline-flex items-center gap-1 text-xs text-red-400"
			>
				<svg
					class="w-3 h-3"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2.5}
					aria-hidden="true"
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
				Failed
			</span>
		);
	}
	return (
		<span
			data-testid="activity-status-cancelled"
			class="inline-flex items-center gap-1 text-xs text-gray-500"
		>
			<svg
				class="w-3 h-3"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={2.5}
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
				/>
			</svg>
			Cancelled
		</span>
	);
}

// ---------------------------------------------------------------------------
// ActivityEntry
// ---------------------------------------------------------------------------

function ActivityEntry({ entry }: { entry: NeoActivityEntry }) {
	const [expanded, setExpanded] = useState(false);

	const target = extractTarget(entry);
	const outcome = extractOutcome(entry);

	return (
		<div data-testid="activity-entry" class="border-b border-gray-800/80 last:border-0">
			{/* Summary row (always visible) */}
			<button
				type="button"
				class="w-full text-left px-3 py-2.5 hover:bg-gray-800/40 transition-colors flex items-start gap-2"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
			>
				{/* Status dot */}
				<div
					class={`flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full ${
						entry.status === 'success'
							? 'bg-green-400'
							: entry.status === 'error'
								? 'bg-red-400'
								: 'bg-gray-600'
					}`}
				/>

				<div class="flex-1 min-w-0">
					<div class="flex items-baseline gap-2 justify-between">
						<span class="text-xs font-semibold text-gray-200 truncate">
							{formatToolName(entry.toolName)}
						</span>
						<div class="flex items-center gap-2 flex-shrink-0">
							<StatusBadge status={entry.status} />
							<span class="text-xs text-gray-600">{formatTimestamp(entry.createdAt)}</span>
						</div>
					</div>

					{target && <p class="text-xs text-gray-500 truncate mt-0.5">{target}</p>}

					{outcome && (
						<p
							class={`text-xs mt-0.5 truncate ${entry.status === 'error' ? 'text-red-400/80' : 'text-gray-400'}`}
						>
							{outcome}
						</p>
					)}
				</div>

				{/* Chevron */}
				<svg
					class={`flex-shrink-0 w-3 h-3 text-gray-600 mt-1 transition-transform ${expanded ? 'rotate-180' : ''}`}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					aria-hidden="true"
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
				</svg>
			</button>

			{/* Expanded details */}
			{expanded && (
				<div data-testid="activity-entry-details" class="px-3 pb-3 space-y-2 bg-gray-800/20">
					<div class="flex items-center justify-between pt-1">
						<span class="text-xs text-gray-600">Status</span>
						<StatusBadge status={entry.status} />
					</div>

					{entry.input && (
						<div>
							<p class="text-xs text-gray-600 mb-1">Input</p>
							<pre class="text-xs text-gray-400 bg-gray-900/60 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all font-mono">
								{(() => {
									try {
										return JSON.stringify(JSON.parse(entry.input), null, 2);
									} catch {
										return entry.input;
									}
								})()}
							</pre>
						</div>
					)}

					{entry.output && (
						<div>
							<p class="text-xs text-gray-600 mb-1">Output</p>
							<pre class="text-xs text-gray-400 bg-gray-900/60 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all font-mono">
								{(() => {
									try {
										return JSON.stringify(JSON.parse(entry.output), null, 2);
									} catch {
										return entry.output;
									}
								})()}
							</pre>
						</div>
					)}

					{entry.error && (
						<div>
							<p class="text-xs text-gray-600 mb-1">Error</p>
							<p class="text-xs text-red-400 bg-red-950/20 rounded-lg p-2">{entry.error}</p>
						</div>
					)}

					<p class="text-xs text-gray-700">{new Date(entry.createdAt).toLocaleString()}</p>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// NeoActivityView
// ---------------------------------------------------------------------------

export function NeoActivityView() {
	const activity = neoStore.activity.value;
	const loading = neoStore.loading.value;

	if (loading && activity.length === 0) {
		return (
			<div class="flex items-center justify-center h-full" data-testid="neo-activity-loading">
				<div class="flex items-center gap-2 text-gray-500 text-xs">
					<div class="w-3 h-3 rounded-full border-2 border-gray-600 border-t-violet-400 animate-spin" />
					Loading activity…
				</div>
			</div>
		);
	}

	if (activity.length === 0) {
		return (
			<div
				data-testid="neo-activity-empty"
				class="flex flex-col items-center justify-center h-full gap-2 text-center px-4"
			>
				<svg
					class="w-8 h-8 text-gray-700"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={1.5}
					aria-hidden="true"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z"
					/>
				</svg>
				<p class="text-xs text-gray-600">No activity yet</p>
				<p class="text-xs text-gray-700">Actions Neo takes will appear here.</p>
			</div>
		);
	}

	return (
		<div data-testid="neo-activity-view" class="flex flex-col h-full min-h-0 overflow-y-auto">
			{activity.map((entry) => (
				<ActivityEntry key={entry.id} entry={entry} />
			))}
		</div>
	);
}
