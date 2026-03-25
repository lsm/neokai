/**
 * MentionToken Component
 *
 * Renders a styled inline pill token for @ref{type:id} mentions in user messages.
 * On hover, lazily fetches full entity data via the reference.resolve RPC and
 * shows a popover with entity details.
 *
 * Performance: wrapped in memo to prevent re-renders during message list scrolling.
 */

import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useState, useCallback } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { useMessageHub } from '../../hooks/useMessageHub.ts';
import type { ReferenceType, ReferenceMetadata, ResolvedReference } from '@neokai/shared';
import { REFERENCE_PATTERN } from '@neokai/shared';

// ─── Type-specific styles ────────────────────────────────────────────────────

const TYPE_STYLES: Record<ReferenceType, { pill: string; label: string }> = {
	task: {
		pill: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40 hover:bg-indigo-500/30',
		label: 'task',
	},
	goal: {
		pill: 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30',
		label: 'goal',
	},
	file: {
		pill: 'bg-blue-500/20 text-blue-300 border-blue-500/40 hover:bg-blue-500/30',
		label: 'file',
	},
	folder: {
		pill: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40 hover:bg-yellow-500/30',
		label: 'folder',
	},
};

// ─── Popover content helpers ─────────────────────────────────────────────────

function renderResolvedContent(resolved: ResolvedReference): JSX.Element {
	switch (resolved.type) {
		case 'task': {
			const d = resolved.data as { title?: string; status?: string; description?: string };
			return (
				<div>
					{d.title && <div class="font-medium text-white">{d.title}</div>}
					{d.status && <div class="text-xs text-gray-400 mt-0.5">Status: {d.status}</div>}
					{d.description && (
						<div class="text-xs text-gray-400 mt-1 line-clamp-2">{d.description}</div>
					)}
				</div>
			);
		}
		case 'goal': {
			const d = resolved.data as { title?: string; status?: string; description?: string };
			return (
				<div>
					{d.title && <div class="font-medium text-white">{d.title}</div>}
					{d.status && <div class="text-xs text-gray-400 mt-0.5">Status: {d.status}</div>}
					{d.description && (
						<div class="text-xs text-gray-400 mt-1 line-clamp-2">{d.description}</div>
					)}
				</div>
			);
		}
		case 'file': {
			const d = resolved.data as {
				path: string;
				size: number;
				binary: boolean;
				truncated: boolean;
			};
			return (
				<div>
					<div class="font-medium text-white font-mono text-xs truncate">{d.path}</div>
					<div class="text-xs text-gray-400 mt-0.5">
						{d.binary ? 'Binary file' : `${Math.round(d.size / 1024)} KB`}
						{d.truncated && ' (truncated)'}
					</div>
				</div>
			);
		}
		case 'folder': {
			const d = resolved.data as { path: string; entries: Array<{ name: string }> };
			return (
				<div>
					<div class="font-medium text-white font-mono text-xs truncate">{d.path}</div>
					<div class="text-xs text-gray-400 mt-0.5">{d.entries.length} entries</div>
				</div>
			);
		}
	}
}

// ─── MentionToken component ──────────────────────────────────────────────────

export interface MentionTokenProps {
	refType: ReferenceType;
	id: string;
	displayText: string;
	status?: string;
	/** Session ID used for reference.resolve RPC calls. Required for hover preview. */
	sessionId?: string;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

function MentionTokenBase({
	refType,
	id,
	displayText,
	status: _status,
	sessionId,
}: MentionTokenProps) {
	const [isHovered, setIsHovered] = useState(false);
	const [loadState, setLoadState] = useState<LoadState>('idle');
	const [resolvedData, setResolvedData] = useState<ResolvedReference | null>(null);
	const { callIfConnected } = useMessageHub();

	const typeStyle = TYPE_STYLES[refType];

	const handleMouseEnter = useCallback(async () => {
		setIsHovered(true);
		// Only fetch once; skip if already fetched or no sessionId to call with
		if (loadState === 'idle' && sessionId) {
			setLoadState('loading');
			try {
				const result = await callIfConnected<{ resolved: ResolvedReference | null }>(
					'reference.resolve',
					{ sessionId, type: refType, id }
				);
				setResolvedData(result?.resolved ?? null);
				setLoadState('loaded');
			} catch {
				setLoadState('error');
			}
		}
	}, [loadState, sessionId, refType, id, callIfConnected]);

	const handleMouseLeave = useCallback(() => {
		setIsHovered(false);
	}, []);

	return (
		<span class="relative inline-block align-baseline">
			<span
				class={cn(
					'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs font-medium cursor-default transition-colors',
					typeStyle.pill
				)}
				onMouseEnter={handleMouseEnter}
				onMouseLeave={handleMouseLeave}
				data-testid="mention-token"
				data-ref-type={refType}
				data-ref-id={id}
			>
				<span class="opacity-60 text-[10px] uppercase tracking-wide">{typeStyle.label}</span>
				<span>{displayText}</span>
			</span>

			{isHovered && (
				<div
					class="absolute bottom-full left-0 mb-2 z-50 min-w-[180px] max-w-[280px] bg-dark-800 border border-gray-600/50 rounded-md shadow-lg p-3 text-sm pointer-events-none animate-fadeIn"
					role="tooltip"
					data-testid="mention-token-popover"
				>
					{loadState === 'loading' && <div class="text-xs text-gray-400">Loading...</div>}
					{loadState === 'loaded' && resolvedData && renderResolvedContent(resolvedData)}
					{loadState === 'loaded' && !resolvedData && (
						<div class="text-xs text-gray-400">Not found</div>
					)}
					{loadState === 'error' && <div class="text-xs text-red-400">Failed to load</div>}
					{loadState === 'idle' && (
						<div class="text-xs text-gray-400">
							{refType}/{id}
						</div>
					)}
				</div>
			)}
		</span>
	);
}

export const MentionToken = memo(MentionTokenBase);

// ─── Text parsing ─────────────────────────────────────────────────────────────

export type TextSegment = { kind: 'text'; content: string };
export type MentionSegment = {
	kind: 'mention';
	raw: string;
	refType: ReferenceType;
	id: string;
	displayText: string;
	status?: string;
};
export type UnknownMentionSegment = { kind: 'unknown-mention'; content: string };
export type Segment = TextSegment | MentionSegment | UnknownMentionSegment;

const VALID_REF_TYPES = new Set<string>(['task', 'goal', 'file', 'folder']);

/**
 * Parse text content into display segments, resolving @ref{type:id} tokens.
 *
 * - Known type + metadata   → MentionSegment with displayText from metadata
 * - Known type + no metadata → MentionSegment with raw id as displayText
 * - Unknown type             → UnknownMentionSegment (rendered with warning styling)
 * - Plain text / plain @     → TextSegment (rendered as-is)
 */
export function parseTextWithReferences(text: string, metadata: ReferenceMetadata): Segment[] {
	const segments: Segment[] = [];
	// Clone the regex to get a fresh lastIndex; never mutate the shared export
	const pattern = new RegExp(REFERENCE_PATTERN.source, REFERENCE_PATTERN.flags);
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(text)) !== null) {
		const raw = match[0];
		const type = match[1];
		const id = match[2];
		const start = match.index;

		if (start > lastIndex) {
			segments.push({ kind: 'text', content: text.slice(lastIndex, start) });
		}

		if (VALID_REF_TYPES.has(type)) {
			const meta = metadata[raw];
			segments.push({
				kind: 'mention',
				raw,
				refType: type as ReferenceType,
				id,
				displayText: meta?.displayText ?? id,
				status: meta?.status,
			});
		} else {
			// Unrecognised type — render as plain text with a subtle warning indicator
			segments.push({ kind: 'unknown-mention', content: raw });
		}

		lastIndex = pattern.lastIndex;
	}

	if (lastIndex < text.length) {
		segments.push({ kind: 'text', content: text.slice(lastIndex) });
	}

	return segments;
}
