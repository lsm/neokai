/**
 * SubagentBlock Component - Displays sub-agent task execution with input/output
 *
 * Renders Task tool calls as a distinct block instead of a generic tool card,
 * showing:
 * - Header: [icon] [subagent_type] [description]
 * - Input: The prompt sent to the sub-agent
 * - Messages: All nested messages from the sub-agent execution
 * - Output: The sub-agent's final response (markdown rendered)
 */

import { useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';
import type { AgentInput } from '@liuboer/shared/sdk/sdk-tools.d.ts';
import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import {
	isTextBlock,
	isToolUseBlock,
	isThinkingBlock,
	type ContentBlock,
} from '@liuboer/shared/sdk/type-guards';
import { ToolResultCard } from './tools/index.ts';
import { ThinkingBlock } from './ThinkingBlock.tsx';

interface SubagentBlockProps {
	/** The Task tool input containing subagent_type, description, prompt */
	input: AgentInput;
	/** The tool result (sub-agent's final response) */
	output?: unknown;
	/** Whether this is an error result */
	isError?: boolean;
	/** The tool use ID */
	toolId: string;
	/** All messages from the sub-agent execution */
	nestedMessages?: SDKMessage[];
	/** Map of tool use IDs to their results (for nested tool calls) */
	toolResultsMap?: Map<string, unknown>;
	/** Additional CSS classes */
	className?: string;
}

/**
 * Get icon for subagent type
 */
function getSubagentIcon(subagentType: string) {
	const iconClass = 'w-5 h-5 flex-shrink-0';

	switch (subagentType.toLowerCase()) {
		case 'explore':
			return (
				<svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
					/>
				</svg>
			);
		case 'plan':
			return (
				<svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
					/>
				</svg>
			);
		case 'general-purpose':
			return (
				<svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
					/>
				</svg>
			);
		case 'claude-code-guide':
			return (
				<svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
					/>
				</svg>
			);
		default:
			// Default agent icon
			return (
				<svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
					/>
				</svg>
			);
	}
}

/**
 * Get color scheme for subagent type
 */
function getSubagentColors(subagentType: string) {
	switch (subagentType.toLowerCase()) {
		case 'explore':
			return {
				bg: 'bg-cyan-50 dark:bg-cyan-900/20',
				border: 'border-cyan-200 dark:border-cyan-800',
				text: 'text-cyan-700 dark:text-cyan-300',
				badge: 'bg-cyan-100 dark:bg-cyan-800/50 text-cyan-700 dark:text-cyan-300',
				icon: 'text-cyan-600 dark:text-cyan-400',
			};
		case 'plan':
			return {
				bg: 'bg-violet-50 dark:bg-violet-900/20',
				border: 'border-violet-200 dark:border-violet-800',
				text: 'text-violet-700 dark:text-violet-300',
				badge: 'bg-violet-100 dark:bg-violet-800/50 text-violet-700 dark:text-violet-300',
				icon: 'text-violet-600 dark:text-violet-400',
			};
		case 'claude-code-guide':
			return {
				bg: 'bg-amber-50 dark:bg-amber-900/20',
				border: 'border-amber-200 dark:border-amber-800',
				text: 'text-amber-700 dark:text-amber-300',
				badge: 'bg-amber-100 dark:bg-amber-800/50 text-amber-700 dark:text-amber-300',
				icon: 'text-amber-600 dark:text-amber-400',
			};
		default:
			return {
				bg: 'bg-indigo-50 dark:bg-indigo-900/20',
				border: 'border-indigo-200 dark:border-indigo-800',
				text: 'text-indigo-700 dark:text-indigo-300',
				badge: 'bg-indigo-100 dark:bg-indigo-800/50 text-indigo-700 dark:text-indigo-300',
				icon: 'text-indigo-600 dark:text-indigo-400',
			};
	}
}

/**
 * Extract text content from output
 */
function extractOutputText(output: unknown): string {
	if (!output) return '';

	if (typeof output === 'string') {
		return output;
	}

	if (typeof output === 'object') {
		const obj = output as Record<string, unknown>;

		// Check for content field (common in tool results)
		if ('content' in obj) {
			const content = obj.content;

			// Handle string content
			if (typeof content === 'string') {
				return content;
			}

			// Handle array of content blocks (Claude API format)
			if (Array.isArray(content)) {
				return content
					.map((block) => {
						if (typeof block === 'string') {
							return block;
						}
						if (typeof block === 'object' && block !== null) {
							const blockObj = block as Record<string, unknown>;
							// Extract text from content blocks like {type: "text", text: "..."}
							if ('text' in blockObj && typeof blockObj.text === 'string') {
								return blockObj.text;
							}
							// Handle other block types that might have content
							if ('content' in blockObj && typeof blockObj.content === 'string') {
								return blockObj.content;
							}
						}
						return '';
					})
					.filter(Boolean)
					.join('\n\n');
			}
		}

		// Check for text field
		if ('text' in obj && typeof obj.text === 'string') {
			return obj.text;
		}

		// Check for result field
		if ('result' in obj && typeof obj.result === 'string') {
			return obj.result;
		}

		// Fallback to JSON
		return JSON.stringify(output, null, 2);
	}

	return String(output);
}

export function SubagentBlock({
	input,
	output,
	isError = false,
	toolId: _toolId,
	nestedMessages = [],
	toolResultsMap,
	className,
}: SubagentBlockProps) {
	const [isExpanded, setIsExpanded] = useState(false);

	const colors = getSubagentColors(input.subagent_type);
	const outputText = extractOutputText(output);

	return (
		<div class={cn('border rounded-lg overflow-hidden', colors.bg, colors.border, className)}>
			{/* Header */}
			<button
				onClick={() => setIsExpanded(!isExpanded)}
				class={cn(
					'w-full flex items-center justify-between p-3 transition-colors',
					'hover:bg-opacity-80 dark:hover:bg-opacity-80'
				)}
			>
				<div class="flex items-center gap-2 min-w-0 flex-1">
					{/* Icon */}
					<span class={colors.icon}>{getSubagentIcon(input.subagent_type)}</span>

					{/* Subagent type badge */}
					<span
						class={cn('text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0', colors.badge)}
					>
						{input.subagent_type}
					</span>

					{/* Description */}
					<span class={cn('text-sm font-medium truncate', colors.text)}>{input.description}</span>
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
						class={cn('w-5 h-5 transition-transform', colors.icon, isExpanded ? 'rotate-180' : '')}
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
					</svg>
				</div>
			</button>

			{/* Expanded content */}
			{isExpanded && (
				<div class={cn('border-t bg-white dark:bg-gray-900', colors.border)}>
					{/* Input section */}
					<div class="border-b border-gray-200 dark:border-gray-700 p-3">
						<div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Input</div>
						<div class="text-sm bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700 whitespace-pre-wrap text-gray-700 dark:text-gray-300">
							{input.prompt}
						</div>
					</div>

					{/* Nested messages section */}
					{nestedMessages.length > 0 && (
						<div class="border-b border-gray-200 dark:border-gray-700 p-3">
							<div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
								Messages ({nestedMessages.length})
							</div>
							<div class="space-y-3">
								{nestedMessages.map((msg, idx) => (
									<NestedMessageRenderer
										key={msg.uuid || `nested-${idx}`}
										message={msg}
										toolResultsMap={toolResultsMap}
									/>
								))}
							</div>
						</div>
					)}

					{/* Output section */}
					<div class="p-3">
						<div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Output</div>
						{outputText ? (
							<div
								class={cn(
									'bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700',
									'prose prose-sm dark:prose-invert max-w-none',
									'prose-pre:bg-gray-900 prose-pre:text-gray-100',
									isError && 'text-red-600 dark:text-red-400'
								)}
							>
								<MarkdownRenderer content={outputText} />
							</div>
						) : (
							<div class="text-sm bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 italic">
								No output yet...
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * Renders a single nested message from the sub-agent execution
 */
function NestedMessageRenderer({
	message,
	toolResultsMap,
}: {
	message: SDKMessage;
	toolResultsMap?: Map<string, unknown>;
}) {
	// Handle assistant messages
	if (message.type === 'assistant') {
		const apiMessage = message.message;
		const content = apiMessage.content as ContentBlock[];

		const textBlocks = content.filter((block) => isTextBlock(block));
		const toolBlocks = content.filter((block) => isToolUseBlock(block));
		const thinkingBlocks = content.filter((block) => isThinkingBlock(block));

		return (
			<div class="space-y-2">
				{/* Thinking blocks */}
				{thinkingBlocks.map((block, idx) => (
					<ThinkingBlock
						key={`thinking-${idx}`}
						content={(block as { thinking: string }).thinking}
					/>
				))}

				{/* Tool use blocks */}
				{toolBlocks.map((block, idx) => {
					const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: unknown };
					const resultData = toolResultsMap?.get(toolBlock.id) as
						| { content: unknown; isOutputRemoved?: boolean }
						| undefined;
					return (
						<ToolResultCard
							key={`tool-${idx}`}
							toolName={toolBlock.name}
							toolId={toolBlock.id}
							input={toolBlock.input}
							output={resultData?.content}
							isError={
								((resultData?.content as Record<string, unknown>)?.is_error as boolean) || false
							}
							variant="default"
							isOutputRemoved={resultData?.isOutputRemoved || false}
						/>
					);
				})}

				{/* Text blocks */}
				{textBlocks.length > 0 && (
					<div class="bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700">
						{textBlocks.map((block, idx) => (
							<div key={idx} class="prose prose-sm dark:prose-invert max-w-none">
								<MarkdownRenderer content={(block as { text: string }).text} />
							</div>
						))}
					</div>
				)}
			</div>
		);
	}

	// Handle user messages (typically tool results)
	if (message.type === 'user') {
		const apiMessage = message.message;
		const content = apiMessage.content;

		// Skip rendering user messages that only contain tool results
		// as they are already shown with the tool use block
		if (Array.isArray(content)) {
			const hasNonToolResultContent = content.some((block) => {
				const blockObj = block as Record<string, unknown>;
				return blockObj.type !== 'tool_result';
			});

			if (!hasNonToolResultContent) {
				return null;
			}

			// Render non-tool-result content blocks
			return (
				<div class="bg-blue-50 dark:bg-blue-900/20 p-3 rounded border border-blue-200 dark:border-blue-800">
					{content.map((block, idx) => {
						const blockObj = block as Record<string, unknown>;
						if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
							return (
								<div key={idx} class="text-sm text-blue-900 dark:text-blue-100">
									{blockObj.text}
								</div>
							);
						}
						return null;
					})}
				</div>
			);
		}

		// Handle string content
		if (typeof content === 'string') {
			return (
				<div class="bg-blue-50 dark:bg-blue-900/20 p-3 rounded border border-blue-200 dark:border-blue-800 text-sm text-blue-900 dark:text-blue-100">
					{content}
				</div>
			);
		}

		return null;
	}

	// Handle result messages
	if (message.type === 'result') {
		const resultMessage = message as SDKMessage & {
			subtype: string;
			result?: string;
			is_error?: boolean;
		};

		if (resultMessage.result) {
			return (
				<div
					class={cn(
						'bg-gray-50 dark:bg-gray-800 p-3 rounded border',
						resultMessage.is_error
							? 'border-red-200 dark:border-red-800 text-red-600 dark:text-red-400'
							: 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300'
					)}
				>
					<div class="text-xs font-semibold mb-1">Result</div>
					<pre class="text-sm whitespace-pre-wrap">{resultMessage.result}</pre>
				</div>
			);
		}
		return null;
	}

	// Handle system messages
	if (message.type === 'system') {
		const systemMessage = message as SDKMessage & { subtype?: string };

		// Skip init messages
		if (systemMessage.subtype === 'init') {
			return null;
		}

		return (
			<div class="bg-gray-100 dark:bg-gray-800 p-2 rounded text-xs text-gray-600 dark:text-gray-400 italic">
				System: {systemMessage.subtype || 'message'}
			</div>
		);
	}

	// Fallback for unknown message types - show raw data
	return (
		<div class="bg-gray-100 dark:bg-gray-800 p-2 rounded text-xs">
			<details>
				<summary class="cursor-pointer text-gray-500">Unknown message type: {message.type}</summary>
				<pre class="mt-2 overflow-x-auto">{JSON.stringify(message, null, 2)}</pre>
			</details>
		</div>
	);
}
