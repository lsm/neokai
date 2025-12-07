/**
 * ToolResultCard Component - Displays completed tool execution results with syntax highlighting
 */

import { useState } from 'preact/hooks';
import type { ToolResultCardProps } from './tool-types.ts';
import { ToolIcon } from './ToolIcon.tsx';
import { ToolSummary } from './ToolSummary.tsx';
import { DiffViewer } from './DiffViewer.tsx';
import { CodeViewer } from './CodeViewer.tsx';
import {
	getToolDisplayName,
	getToolColors,
	getOutputDisplayText,
	hasCustomRenderer,
	getCustomRenderer,
	shouldExpandByDefault,
} from './tool-utils.ts';
import { cn } from '../../../lib/utils.ts';

/**
 * Strip line numbers from Read tool output
 * Read tool output format: "   1→content\n   2→content"
 */
function stripLineNumbers(content: string): string {
	return content
		.split('\n')
		.map((line) => {
			// Match pattern: optional spaces, digits, →, then content
			const match = line.match(/^\s*\d+→(.*)$/);
			return match ? match[1] : line;
		})
		.join('\n');
}

/**
 * ToolResultCard Component
 */
export function ToolResultCard({
	toolName,
	toolId,
	input,
	output,
	isError = false,
	variant = 'default',
	defaultExpanded,
	className,
}: ToolResultCardProps) {
	const colors = getToolColors(toolName);
	const displayName = getToolDisplayName(toolName);
	const shouldExpand =
		defaultExpanded !== undefined ? defaultExpanded : shouldExpandByDefault(toolName);
	const [isExpanded, setIsExpanded] = useState(shouldExpand);
	const customRenderer = hasCustomRenderer(toolName) ? getCustomRenderer(toolName) : null;

	// Compact variant - minimal display
	if (variant === 'compact') {
		return (
			<div
				class={cn(
					'flex items-center gap-2 py-1 px-2 rounded border',
					colors.bg,
					colors.border,
					className
				)}
			>
				<ToolIcon toolName={toolName} size="sm" />
				<span class={cn('text-xs font-medium truncate', colors.text)}>{displayName}</span>
				{isError && (
					<svg
						class="w-3 h-3 text-red-500 ml-auto flex-shrink-0"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				)}
			</div>
		);
	}

	// Inline variant - for text flow
	if (variant === 'inline') {
		return (
			<span
				class={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded', colors.bg, className)}
			>
				<ToolIcon toolName={toolName} size="xs" />
				<span class={cn('text-xs font-medium', colors.text)}>{displayName}</span>
				{isError && <span class="text-xs text-red-500">✗</span>}
			</span>
		);
	}

	// Default & detailed variants - full display with expand/collapse
	return (
		<div class={cn('border rounded-lg overflow-hidden', colors.bg, colors.border, className)}>
			{/* Header - clickable to expand/collapse */}
			<button
				onClick={() => setIsExpanded(!isExpanded)}
				class={cn(
					'w-full flex items-center justify-between p-3 transition-colors',
					'hover:bg-opacity-80 dark:hover:bg-opacity-80'
				)}
			>
				<div class="flex items-center gap-2 min-w-0 flex-1">
					<ToolIcon toolName={toolName} size="md" />
					<span class={cn('font-semibold text-sm flex-shrink-0', colors.text)}>{displayName}</span>
					<span class={cn('text-sm font-mono truncate', colors.lightText)}>
						<ToolSummary toolName={toolName} input={input} maxLength={60} />
					</span>
				</div>

				<div class="flex items-center gap-2 flex-shrink-0">
					{isError && (
						<svg
							class="w-4 h-4 text-red-600 dark:text-red-400"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					)}
					<svg
						class={cn(
							'w-5 h-5 transition-transform',
							colors.iconColor,
							isExpanded ? 'rotate-180' : ''
						)}
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
					</svg>
				</div>
			</button>

			{/* Expanded content - input and output details */}
			{isExpanded && (
				<div class={cn('p-3 border-t bg-white dark:bg-gray-900 space-y-3', colors.border)}>
					{/* Custom renderer takes priority */}
					{customRenderer ? (
						customRenderer({ toolName, input, output, isError, variant })
					) : /* Special handling for Edit tool - show diff view */
					toolName === 'Edit' && input?.old_string && input?.new_string ? (
						<DiffViewer
							oldText={input.old_string}
							newText={input.new_string}
							filePath={input.file_path}
						/>
					) : /* Special handling for Read tool - show syntax-highlighted code */
					toolName === 'Read' &&
					  output &&
					  (typeof output === 'string' ||
							(typeof output === 'object' &&
								'content' in output &&
								typeof output.content === 'string')) ? (
						<CodeViewer
							code={stripLineNumbers(typeof output === 'string' ? output : output.content)}
							filePath={input?.file_path}
							showLineNumbers={true}
							showHeader={true}
							maxHeight="none"
						/>
					) : /* Special handling for Write tool - show syntax-highlighted code */
					toolName === 'Write' && input?.content && typeof input.content === 'string' ? (
						<div>
							{variant === 'detailed' && (
								<div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
									File Content:
								</div>
							)}
							<CodeViewer
								code={input.content}
								filePath={input.file_path}
								showLineNumbers={true}
								showHeader={true}
								maxHeight="none"
							/>
						</div>
					) : /* Special handling for Thinking tool - just show the content */
					toolName === 'Thinking' ? (
						<div>
							{variant === 'detailed' && (
								<div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
									Extended Thinking Process ({typeof input === 'string' ? input.length : 0}{' '}
									characters)
								</div>
							)}
							<div
								class={cn('text-xs p-3 rounded overflow-x-auto border', colors.bg, colors.border)}
							>
								<pre class={cn('text-sm whitespace-pre-wrap font-mono', colors.text)}>
									{typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
								</pre>
							</div>
							{variant === 'detailed' && (
								<div class="text-xs text-gray-500 dark:text-gray-400 italic">
									This is Claude's internal reasoning process before generating the final response.
								</div>
							)}
						</div>
					) : (
						<>
							{/* Tool ID (only in detailed variant) */}
							{variant === 'detailed' && (
								<div>
									<div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">
										Tool ID:
									</div>
									<div class="text-xs font-mono text-gray-700 dark:text-gray-300 break-all">
										{toolId}
									</div>
								</div>
							)}

							{/* Input */}
							<div>
								<div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
									Input:
								</div>
								<pre class="text-xs bg-gray-50 dark:bg-gray-800 p-3 rounded overflow-x-auto border border-gray-200 dark:border-gray-700">
									{JSON.stringify(input, null, 2)}
								</pre>
							</div>

							{/* Output/Result */}
							{output !== undefined && output !== null && (
								<div>
									<div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
										Output:
										{isError && <span class="ml-2 text-red-600 dark:text-red-400">(Error)</span>}
									</div>
									<pre
										class={cn(
											'text-xs p-3 rounded overflow-x-auto border',
											isError
												? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-900 dark:text-red-100'
												: 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100'
										)}
									>
										{getOutputDisplayText(output)}
									</pre>
								</div>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
