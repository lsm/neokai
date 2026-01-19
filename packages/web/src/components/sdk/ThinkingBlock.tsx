/**
 * ThinkingBlock Component - Displays Claude's extended thinking process
 *
 * Unlike other tool cards that collapse by default, thinking blocks are:
 * - Always visible (preview mode)
 * - Truncated after ~6 lines with gradient fade
 * - Expandable via "Show more" button at bottom edge
 */

import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';

interface ThinkingBlockProps {
	content: string;
	className?: string;
}

// Number of lines to show in preview mode
const PREVIEW_LINE_COUNT = 6;
// Approximate line height in pixels (for line-clamp calculation)
const LINE_HEIGHT_PX = 20;
// Max height for preview mode
const PREVIEW_MAX_HEIGHT = PREVIEW_LINE_COUNT * LINE_HEIGHT_PX;

// Amber color scheme for thinking blocks (matching tool-registry)
const colors = {
	bg: 'bg-amber-50 dark:bg-amber-900/20',
	text: 'text-amber-900 dark:text-amber-100',
	border: 'border-amber-200 dark:border-amber-800',
	iconColor: 'text-amber-600 dark:text-amber-400',
	lightText: 'text-amber-700 dark:text-amber-300',
};

export function ThinkingBlock({ content, className }: ThinkingBlockProps) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [needsTruncation, setNeedsTruncation] = useState(false);
	const contentRef = useRef<HTMLPreElement>(null);

	// Check if content exceeds preview height
	useLayoutEffect(() => {
		if (contentRef.current) {
			const scrollHeight = contentRef.current.scrollHeight;
			setNeedsTruncation(scrollHeight > PREVIEW_MAX_HEIGHT);
		}
	}, [content]);

	const charCount = content.length;

	return (
		<div
			class={cn('border rounded-lg overflow-hidden', colors.bg, colors.border, className)}
			data-testid="thinking-block"
		>
			{/* Header */}
			<div class={cn('flex items-center gap-2 px-3 py-2', colors.bg)}>
				{/* Lightbulb icon */}
				<svg
					class={cn('w-4 h-4 flex-shrink-0', colors.iconColor)}
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
					/>
				</svg>
				<span class={cn('text-sm font-semibold', colors.text)}>Thinking</span>
				<span class={cn('text-xs', colors.lightText)}>
					• {charCount.toLocaleString()} character{charCount !== 1 ? 's' : ''}
				</span>
			</div>

			{/* Content area */}
			<div class={cn('relative border-t', colors.border)}>
				<div
					class={cn(
						'p-3 bg-white dark:bg-gray-900',
						!isExpanded && needsTruncation && 'overflow-hidden'
					)}
					style={
						!isExpanded && needsTruncation ? { maxHeight: `${PREVIEW_MAX_HEIGHT + 24}px` } : {}
					}
				>
					<pre ref={contentRef} class={cn('text-sm whitespace-pre-wrap font-mono', colors.text)}>
						{content}
					</pre>
				</div>

				{/* Gradient fade overlay when truncated and not expanded */}
				{needsTruncation && !isExpanded && (
					<div
						class="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-white dark:from-gray-900 to-transparent pointer-events-none"
						aria-hidden="true"
					/>
				)}

				{/* Expand/Collapse button at bottom edge */}
				{needsTruncation && (
					<div
						class={cn('flex justify-center py-2 border-t bg-white dark:bg-gray-900', colors.border)}
					>
						<button
							onClick={() => setIsExpanded(!isExpanded)}
							class={cn(
								'flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors',
								'hover:bg-amber-100 dark:hover:bg-amber-900/40',
								colors.text
							)}
						>
							{isExpanded ? (
								<>
									<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
									<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
	);
}
