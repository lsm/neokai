/**
 * SyntheticMessageBlock Component
 *
 * Reusable component for rendering synthetic (system-generated) user messages.
 * Used for interrupt messages, compaction summaries, and other synthetic content.
 *
 * Design:
 * - Subtle dark card (gray-900 bg, gray-700 border) — purple is accent only
 * - Renders markdown for text blocks (headings, lists, code blocks)
 * - Collapsible by default when content exceeds 8 lines
 * - Right-aligned (user-side bubble placement)
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { toast } from '../../lib/toast.ts';
import { cn, copyToClipboard } from '../../lib/utils.ts';
import { messageSpacing, borderRadius } from '../../lib/design-tokens.ts';
import { Tooltip } from '../ui/Tooltip.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';

interface Props {
	/** Content to display - can be a simple string or array of content blocks */
	content: string | Array<Record<string, unknown>>;
	/** Optional timestamp in milliseconds */
	timestamp?: number;
	/** Optional UUID for data attributes */
	uuid?: string;
}

// Number of lines to show in preview mode before "Show more"
const PREVIEW_LINE_COUNT = 8;
// Approximate line height in pixels (matches typical 1.5em line height at 14px)
const LINE_HEIGHT_PX = 21;

/**
 * Format timestamp for display (e.g., "09:32 PM")
 */
function formatTime(timestamp?: number): string {
	if (!timestamp) return '';
	const date = new Date(timestamp);
	return date.toLocaleTimeString('en-US', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: true,
	});
}

/**
 * Format full timestamp for tooltip (e.g., "December 22, 2024 at 09:32:15 PM")
 */
function formatFullTimestamp(timestamp?: number): string {
	if (!timestamp) return '';
	const date = new Date(timestamp);
	return date.toLocaleString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: true,
	});
}

/**
 * Count approximate lines in the raw text content.
 * Used for the "N lines" indicator in the collapsed header.
 */
function countTextLines(content: string | Array<Record<string, unknown>>): number {
	if (typeof content === 'string') {
		return content.split('\n').length;
	}
	let total = 0;
	for (const block of content) {
		if (block.type === 'text' && typeof block.text === 'string') {
			total += (block.text as string).split('\n').length;
		} else {
			// Non-text blocks contribute at least a few lines each
			total += 3;
		}
	}
	return Math.max(1, total);
}

/**
 * Synthetic Message Block - Renders system-generated user messages with subtle
 * dark card, markdown rendering, and collapsible content.
 */
export function SyntheticMessageBlock({ content, timestamp, uuid }: Props) {
	// Normalize content to array of blocks
	const contentBlocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;

	// Extract text content for copy functionality
	const getTextContent = (): string => {
		if (typeof content === 'string') return content;
		return contentBlocks
			.map((block) => {
				if (block.type === 'text') return block.text as string;
				return '';
			})
			.filter(Boolean)
			.join('\n');
	};

	const [copied, setCopied] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [needsCollapse, setNeedsCollapse] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);
	const previewMaxHeight = PREVIEW_LINE_COUNT * LINE_HEIGHT_PX;

	// Initial measurement via useLayoutEffect
	useLayoutEffect(() => {
		if (contentRef.current) {
			setNeedsCollapse(contentRef.current.scrollHeight > previewMaxHeight);
		}
	}, [content, previewMaxHeight]);

	// ResizeObserver re-measures after MarkdownRenderer async-renders HTML content
	useEffect(() => {
		const el = contentRef.current;
		if (!el) return;

		if (typeof ResizeObserver === 'undefined') return;

		const observer = new ResizeObserver(() => {
			setNeedsCollapse(el.scrollHeight > previewMaxHeight);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [previewMaxHeight]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);

	const handleCopy = async () => {
		const success = await copyToClipboard(getTextContent());
		if (success) {
			setCopied(true);
		} else {
			toast.error('Failed to copy message');
		}
	};

	const lineCount = countTextLines(content);

	return (
		<div
			class={cn(messageSpacing.user.container.combined, 'flex justify-end')}
			data-testid="synthetic-message"
			data-message-role="synthetic"
			data-message-uuid={uuid}
			data-message-timestamp={timestamp || 0}
		>
			<div class="max-w-[85%] md:max-w-[70%] w-auto">
				<div
					class={cn('bg-gray-900 border border-gray-700', borderRadius.message.bubble)}
					data-testid="synthetic-card"
				>
					{/* Header — purple accent only (dot + label) */}
					<div class="flex items-center gap-2 px-3 py-2 border-b border-gray-700">
						<div
							class="w-2 h-2 rounded-full bg-purple-500 flex-shrink-0"
							data-testid="synthetic-dot"
						/>
						<span class="text-xs font-semibold text-purple-400">Synthetic</span>
						{!isExpanded && needsCollapse && (
							<span class="text-xs text-gray-500">— {lineCount} lines</span>
						)}
					</div>

					{/* Collapsible content area */}
					<div class="relative">
						<div
							class={cn('px-3 py-2', !isExpanded && needsCollapse && 'overflow-hidden')}
							style={
								!isExpanded && needsCollapse ? { maxHeight: `${previewMaxHeight + 24}px` } : {}
							}
						>
							{/* Inner ref measured for height — outside the maxHeight container */}
							<div ref={contentRef} class="space-y-2">
								{contentBlocks.map((block, idx) => (
									<div key={idx} class="text-sm">
										{block.type === 'text' && (
											<MarkdownRenderer
												content={block.text as string}
												class="text-gray-200 text-sm"
											/>
										)}
										{block.type === 'image' && (
											<div class="space-y-1">
												<div class="text-xs text-purple-400">Image:</div>
												<div class="font-mono text-xs text-gray-300 bg-gray-800/50 p-2 rounded overflow-x-auto">
													{JSON.stringify(block, null, 2)}
												</div>
											</div>
										)}
										{block.type === 'tool_use' && (
											<div class="space-y-1">
												<div class="text-xs text-purple-400">Tool Use: {block.name as string}</div>
												<div class="font-mono text-xs text-gray-300 bg-gray-800/50 p-2 rounded overflow-x-auto">
													{JSON.stringify(block.input, null, 2)}
												</div>
											</div>
										)}
										{block.type === 'tool_result' && (
											<div class="space-y-1">
												<div class="text-xs text-purple-400">
													Tool Result: {(block.tool_use_id as string).slice(0, 12)}
													...
												</div>
												<div class="font-mono text-xs text-gray-300 bg-gray-800/50 p-2 rounded max-h-48 overflow-auto">
													{block.content !== undefined && block.content !== null
														? typeof block.content === 'string'
															? block.content
															: JSON.stringify(block.content, null, 2)
														: '(empty)'}
												</div>
											</div>
										)}
										{!['text', 'image', 'tool_use', 'tool_result'].includes(
											block.type as string
										) && (
											<div class="space-y-1">
												<div class="text-xs text-purple-400">{block.type as string}:</div>
												<div class="font-mono text-xs text-gray-300 bg-gray-800/50 p-2 rounded overflow-x-auto">
													{JSON.stringify(block, null, 2)}
												</div>
											</div>
										)}
									</div>
								))}
							</div>
						</div>

						{/* Gradient fade overlay when truncated and not expanded */}
						{needsCollapse && !isExpanded && (
							<div
								class="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-gray-900 to-transparent pointer-events-none"
								aria-hidden="true"
							/>
						)}

						{/* Show more / Show less toggle */}
						{needsCollapse && (
							<div class="flex justify-center py-2 border-t border-gray-700">
								<button
									onClick={() => setIsExpanded(!isExpanded)}
									class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors text-gray-400 hover:text-gray-200 hover:bg-gray-800"
									data-testid="synthetic-toggle"
								>
									{isExpanded ? (
										<>
											<svg
												class="w-3.5 h-3.5"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M5 15l7-7 7 7"
												/>
											</svg>
											Show less
										</>
									) : (
										<>
											<svg
												class="w-3.5 h-3.5"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M19 9l-7 7-7-7"
												/>
											</svg>
											Show more
										</>
									)}
								</button>
							</div>
						)}
					</div>
				</div>

				{/* Actions and timestamp */}
				<div
					class={cn(
						'flex items-center justify-end',
						messageSpacing.actions.gap,
						messageSpacing.actions.marginTop,
						messageSpacing.actions.padding
					)}
				>
					{timestamp && (
						<Tooltip content={formatFullTimestamp(timestamp)} position="left">
							<span class="text-xs text-gray-500">{formatTime(timestamp)}</span>
						</Tooltip>
					)}

					<Tooltip content="System-generated message" position="left">
						<span class="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded">
							synthetic
						</span>
					</Tooltip>

					<IconButton
						size="md"
						onClick={handleCopy}
						title={copied ? 'Copied!' : 'Copy message'}
						class={copied ? 'text-green-400' : ''}
					>
						{copied ? (
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M5 13l4 4L19 7"
								/>
							</svg>
						) : (
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
								/>
							</svg>
						)}
					</IconButton>
				</div>
			</div>
		</div>
	);
}
