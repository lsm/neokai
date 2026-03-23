/**
 * AgentTurnBlock Component - Renders an agent turn using SubagentBlock structure
 *
 * Uses the same layout as SubagentBlock (Input / Messages / Output sections)
 * but applies role-based colors instead of subagent-type colors.
 *
 * The outer wrapper uses role colors:
 * - planner: teal
 * - leader: purple
 * - coder: blue
 * - general: slate
 */

import { useMemo } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import {
	isTextBlock,
	isToolUseBlock,
	isThinkingBlock,
	type ContentBlock,
} from '@neokai/shared/sdk/type-guards';
import { ToolResultCard } from '../sdk/tools/index.ts';
import { ThinkingBlock } from '../sdk/ThinkingBlock.tsx';
import type { TurnBlock } from '../../hooks/useTurnBlocks';

interface AgentTurnBlockProps {
	turn: TurnBlock;
	className?: string;
}

/**
 * Get color scheme for agent role
 */
function getRoleColors(role: string) {
	switch (role.toLowerCase()) {
		case 'planner':
			return {
				bg: 'bg-teal-50 dark:bg-teal-900/20',
				border: 'border-teal-200 dark:border-teal-800',
				text: 'text-teal-700 dark:text-teal-300',
				badge: 'bg-teal-100 dark:bg-teal-800/50 text-teal-700 dark:text-teal-300',
				icon: 'text-teal-600 dark:text-teal-400',
			};
		case 'leader':
			return {
				bg: 'bg-purple-50 dark:bg-purple-900/20',
				border: 'border-purple-200 dark:border-purple-800',
				text: 'text-purple-700 dark:text-purple-300',
				badge: 'bg-purple-100 dark:bg-purple-800/50 text-purple-700 dark:text-purple-300',
				icon: 'text-purple-600 dark:text-purple-400',
			};
		case 'coder':
			return {
				bg: 'bg-blue-50 dark:bg-blue-900/20',
				border: 'border-blue-200 dark:border-blue-800',
				text: 'text-blue-700 dark:text-blue-300',
				badge: 'bg-blue-100 dark:bg-blue-800/50 text-blue-700 dark:text-blue-300',
				icon: 'text-blue-600 dark:text-blue-400',
			};
		default:
			return {
				bg: 'bg-slate-50 dark:bg-slate-900/20',
				border: 'border-slate-200 dark:border-slate-800',
				text: 'text-slate-700 dark:text-slate-300',
				badge: 'bg-slate-100 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300',
				icon: 'text-slate-600 dark:text-slate-400',
			};
	}
}

/**
 * Renders a single nested message from the sub-agent execution
 * This is copied from SubagentBlock.tsx - same logic
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
						compact={true}
					/>
				))}

				{/* Tool use blocks */}
				{toolBlocks.map((block, idx) => {
					const toolBlock = block as {
						type: 'tool_use';
						id: string;
						name: string;
						input: unknown;
					};
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
							disableExpand
						/>
					);
				})}

				{/* Text blocks - rendered like thinking block: header + one-line preview */}
				{textBlocks.map((block, idx) => {
					const text = (block as { text: string }).text.trim();
					if (!text) return null;
					return (
						<div
							key={`text-${idx}`}
							class="border rounded-lg overflow-hidden bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
						>
							<div class="flex items-center gap-2 px-3 py-2 bg-green-50 dark:bg-green-900/20">
								<svg
									class="w-4 h-4 flex-shrink-0 text-green-600 dark:text-green-400"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
									/>
								</svg>
								<span class="text-sm font-semibold text-green-900 dark:text-green-100">
									Assistant
								</span>
							</div>
							<div class="relative border-t border-green-200 dark:border-green-800">
								<div class="p-3 bg-white dark:bg-gray-900">
									<div
										class="text-sm text-green-800 dark:text-green-200 prose prose-sm prose-p:my-0 dark:prose-invert [&>*]:my-0 whitespace-normal break-words line-clamp-1"
										style="max-width: 100%"
									>
										<MarkdownRenderer content={text} />
									</div>
								</div>
							</div>
						</div>
					);
				})}
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
								<div
									key={idx}
									class="text-sm text-blue-900 dark:text-blue-100 whitespace-pre-wrap break-words"
								>
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
				<div class="bg-blue-50 dark:bg-blue-900/20 p-3 rounded border border-blue-200 dark:border-blue-800 text-sm text-blue-900 dark:text-blue-100 whitespace-pre-wrap break-words">
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
					<pre class="text-sm whitespace-pre-wrap break-words overflow-x-auto">
						{resultMessage.result}
					</pre>
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

export function AgentTurnBlock({ turn, className }: AgentTurnBlockProps) {
	const colors = getRoleColors(turn.agentRole);

	// Extract the first user message as input prompt, rest are nested messages
	const { inputMessage, nestedMessages } = useMemo(() => {
		if (turn.messages.length === 0) return { inputMessage: null, nestedMessages: [] };

		const first = turn.messages[0];
		if (first.type === 'user') {
			return {
				inputMessage: first,
				nestedMessages: turn.messages.slice(1),
			};
		}
		return { inputMessage: null, nestedMessages: turn.messages };
	}, [turn.messages]);

	// Extract text content from a user message for the input section
	const inputText = useMemo(() => {
		if (!inputMessage || inputMessage.type !== 'user') return null;
		const content = inputMessage.message.content;
		if (typeof content === 'string') return content;
		if (Array.isArray(content)) {
			const textBlock = content.find((b) => (b as { type: string }).type === 'text');
			return textBlock ? (textBlock as { text: string }).text : null;
		}
		return null;
	}, [inputMessage]);

	return (
		<div class={cn('border rounded-lg overflow-hidden', colors.bg, colors.border, className)}>
			{/* Header - always visible, matches SubagentBlock header style */}
			<div class={cn('flex items-center justify-between p-3', colors.bg)}>
				<div class="flex items-center gap-2 min-w-0 flex-1">
					{/* Agent icon */}
					<span class={colors.icon}>
						<svg
							class="w-5 h-5 flex-shrink-0"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
							/>
						</svg>
					</span>

					{/* Agent role badge */}
					<span
						class={cn('text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0', colors.badge)}
					>
						{turn.agentLabel}
					</span>
				</div>

				<div class="flex items-center gap-2 flex-shrink-0">
					{/* Tool call count */}
					{turn.toolCallCount > 0 && (
						<span class="flex items-center gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
								/>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
								/>
							</svg>
							{turn.toolCallCount}
						</span>
					)}

					{/* Thinking count */}
					{turn.thinkingCount > 0 && (
						<span class="flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
								/>
							</svg>
							{turn.thinkingCount}
						</span>
					)}

					{/* Assistant message count */}
					{turn.assistantCount > 0 && (
						<span class="flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
								/>
							</svg>
							{turn.assistantCount}
						</span>
					)}

					{turn.isError && (
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
				</div>
			</div>

			{/* Messages section - always expanded, matches SubagentBlock Messages section */}
			<div class={cn('border-t bg-white dark:bg-gray-900', colors.border)}>
				{/* Input section */}
				{inputText && (
					<div class="border-b border-gray-200 dark:border-gray-700 p-3">
						<div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Input</div>
						<div class="text-sm bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700 whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">
							<MarkdownRenderer content={inputText} />
						</div>
					</div>
				)}

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
									toolResultsMap={new Map()}
								/>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
