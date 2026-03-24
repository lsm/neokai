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

import { memo } from 'preact/compat';
import { useMemo, useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { borderRadius, messageColors, messageSpacing } from '../../lib/design-tokens.ts';
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
import { IconButton } from '../ui/IconButton.tsx';
import { Tooltip } from '../ui/Tooltip.tsx';
import type { TurnBlock } from '../../hooks/useTurnBlocks';

const EMPTY_TOOL_RESULTS = new Map<string, unknown>();

function normalizeWS(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

function isRenderable(msg: SDKMessage): boolean {
	if (msg.type === 'result') {
		return (msg as SDKMessage & { is_error?: boolean }).is_error === true;
	}
	if (msg.type === 'system') {
		const sub = (msg as SDKMessage & { subtype?: string }).subtype;
		return sub !== 'init' && sub !== 'task_started';
	}
	if (msg.type === 'user') {
		const msgContent = (msg as SDKMessage & { message?: { content?: unknown } }).message?.content;
		if (Array.isArray(msgContent)) {
			return msgContent.some((b) => (b as { type: string }).type !== 'tool_result');
		}
		return typeof msgContent === 'string';
	}
	if (msg.type === 'assistant') {
		const msgContent = (msg as SDKMessage & { message?: { content?: unknown[] } }).message?.content;
		return Array.isArray(msgContent) && msgContent.length > 0;
	}
	return true;
}

interface AgentTurnBlockProps {
	turn: TurnBlock;
	className?: string;
	onHeaderClick?: (turn: TurnBlock) => void;
}

/**
 * Get color scheme for agent role
 */
function getRoleColors(role: string) {
	switch (role.toLowerCase()) {
		case 'planner':
			return {
				bg: 'bg-cyan-50 dark:bg-cyan-900/20',
				border: 'border-cyan-200 dark:border-cyan-800',
				text: 'text-cyan-700 dark:text-cyan-300',
				badge: 'bg-cyan-100 dark:bg-cyan-800/50 text-cyan-700 dark:text-cyan-300',
				icon: 'text-cyan-600 dark:text-cyan-400',
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

function getMsgTime(timestamp: number): string {
	if (!timestamp) return '';
	return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms: number): string {
	const totalSecs = Math.round(ms / 1000);
	if (totalSecs < 60) return `${totalSecs}s`;
	const totalMins = Math.floor(totalSecs / 60);
	const secs = totalSecs % 60;
	if (totalMins < 60) return secs > 0 ? `${totalMins}m ${secs}s` : `${totalMins}m`;
	const hours = Math.floor(totalMins / 60);
	const mins = totalMins % 60;
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function getMsgFullTime(timestamp: number): string {
	if (!timestamp) return '';
	return new Date(timestamp).toLocaleString();
}

/** Identical to the copy+time actions row used in SDKAssistantMessage / SDKUserMessage. */
function MessageActions({
	text,
	timestamp,
	align = 'left',
}: {
	text: string;
	timestamp: number;
	align?: 'left' | 'right';
}) {
	const [copied, setCopied] = useState(false);
	const handleCopy = () => {
		navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};
	return (
		<div
			class={cn(
				'flex items-center',
				messageSpacing.actions.gap,
				messageSpacing.actions.marginTop,
				messageSpacing.actions.padding,
				align === 'right' && 'justify-end'
			)}
		>
			{timestamp > 0 && (
				<Tooltip
					content={getMsgFullTime(timestamp)}
					position={align === 'right' ? 'left' : 'right'}
				>
					<span class="text-xs text-gray-500">{getMsgTime(timestamp)}</span>
				</Tooltip>
			)}
			<IconButton
				size="md"
				onClick={handleCopy}
				title={copied ? 'Copied!' : 'Copy message'}
				class={copied ? 'text-green-400' : ''}
			>
				{copied ? (
					<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
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
	);
}

/**
 * Renders a single nested message from the sub-agent execution
 * This is copied from SubagentBlock.tsx - same logic
 */
function NestedMessageRenderer({
	message,
	toolResultsMap,
	isLast = false,
	inputText = null,
	seenTexts = new Set<string>(),
}: {
	message: SDKMessage;
	toolResultsMap?: Map<string, unknown>;
	isLast?: boolean;
	inputText?: string | null;
	seenTexts?: Set<string>;
}) {
	const timestamp = (message as { timestamp?: number }).timestamp ?? 0;

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

				{/* Text blocks - use bubble style like normal session */}
				{textBlocks.map((block, idx) => {
					const rawText = (block as { text: string }).text;
					const text = rawText.trim();
					if (!text) return null;
					// Skip if this text matches the input prompt (duplicate of User card)
					// Normalize whitespace for comparison to handle formatting differences
					if (inputText && normalizeWS(text) === normalizeWS(inputText)) return null;
					return (
						<div key={`text-${idx}`}>
							<div
								class={cn(
									messageSpacing.assistant.bubble.combined,
									messageColors.assistant.background,
									messageColors.assistant.text,
									borderRadius.message.bubble,
									'w-full'
								)}
							>
								{isLast ? (
									<div class="prose prose-sm max-w-full overflow-x-auto">
										<MarkdownRenderer content={text} />
									</div>
								) : (
									<div
										class="prose prose-sm prose-p:my-0 [&>*]:my-0 whitespace-normal break-words line-clamp-1"
										style="max-width: 100%"
									>
										<MarkdownRenderer content={text} />
									</div>
								)}
							</div>
							<MessageActions text={text} timestamp={timestamp} align="left" />
						</div>
					);
				})}
			</div>
		);
	}

	// Handle user messages (typically tool results)
	if (message.type === 'user') {
		// Skip synthetic user messages - these are sub-agent prompts that duplicate Task tool input
		const userMessage = message as { isSynthetic?: boolean };
		if (userMessage.isSynthetic) return null;

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

			// Normalize whitespace for comparison

			// Render non-tool-result content blocks, skipping:
			// 1. Duplicates of inputText
			// 2. Texts we've already rendered (for parallel sub-agent deduplication)
			const textBlocks = content.filter((block) => {
				const blockObj = block as Record<string, unknown>;
				if (blockObj.type !== 'text' || typeof blockObj.text !== 'string') return false;
				const normalized = normalizeWS(blockObj.text);
				if (inputText && normalized === normalizeWS(inputText)) return false;
				if (seenTexts.has(normalized)) return false;
				return true;
			});

			if (textBlocks.length === 0) return null;

			// Add rendered texts to seenTexts for deduplication
			textBlocks.forEach((block) => {
				const blockObj = block as Record<string, unknown>;
				if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
					seenTexts.add(normalizeWS(blockObj.text));
				}
			});

			const copyText = textBlocks
				.map((b) => (b as Record<string, unknown>).text as string)
				.join('\n');
			return (
				<div class="flex flex-col items-end">
					<div
						class={cn(
							messageSpacing.user.bubble.combined,
							messageColors.user.background,
							messageColors.user.text,
							borderRadius.message.bubble,
							'max-w-[85%] md:max-w-[70%]'
						)}
					>
						{textBlocks.map((block, idx) => {
							const blockObj = block as Record<string, unknown>;
							return (
								<div key={idx} class="whitespace-pre-wrap break-words">
									{blockObj.text as string}
								</div>
							);
						})}
					</div>
					<MessageActions text={copyText} timestamp={timestamp} align="right" />
				</div>
			);
		}

		// Handle string content
		if (typeof content === 'string') {
			return (
				<div class="flex flex-col items-end">
					<div
						class={cn(
							messageSpacing.user.bubble.combined,
							messageColors.user.background,
							messageColors.user.text,
							borderRadius.message.bubble,
							'max-w-[85%] md:max-w-[70%]',
							'whitespace-pre-wrap break-words'
						)}
					>
						{content}
					</div>
					<MessageActions text={content} timestamp={timestamp} align="right" />
				</div>
			);
		}

		return null;
	}

	// Handle result messages - skip non-error results since the last assistant
	// message already renders the final output
	if (message.type === 'result') {
		const resultMessage = message as SDKMessage & {
			subtype: string;
			result?: string;
			is_error?: boolean;
		};

		if (!resultMessage.is_error) return null;

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

		// Skip init and task_started messages - these are noise
		if (systemMessage.subtype === 'init' || systemMessage.subtype === 'task_started') {
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

function AgentTurnBlockInner({ turn, className, onHeaderClick }: AgentTurnBlockProps) {
	const colors = useMemo(() => getRoleColors(turn.agentRole), [turn.agentRole]);

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
			{/* Header - clickable to open slide-out panel */}
			<div
				class={cn(
					'flex items-center justify-between p-3',
					onHeaderClick &&
						'cursor-pointer hover:brightness-95 dark:hover:brightness-110 transition-[filter]'
				)}
				onClick={onHeaderClick ? () => onHeaderClick(turn) : undefined}
			>
				<div class="flex items-center gap-2 min-w-0 flex-1">
					{/* Agent icon */}
					<span class={colors.icon}>
						{turn.agentRole === 'planner' ? (
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
									d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
								/>
							</svg>
						) : (
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
						)}
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

					{/* Chevron — shown only when header is clickable */}
					{onHeaderClick && (
						<svg
							class="w-4 h-4 text-gray-400 dark:text-gray-500 ml-1 flex-shrink-0"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
						</svg>
					)}
				</div>
			</div>

			{/* Messages section - always expanded, matches SubagentBlock Messages section */}
			<div class={cn('border-t bg-white dark:bg-gray-900', colors.border)}>
				{/* Input section */}
				{inputText && (
					<div class="p-3">
						<div class="flex flex-col items-end">
							<div
								class={cn(
									messageSpacing.user.bubble.combined,
									messageColors.user.background,
									messageColors.user.text,
									borderRadius.message.bubble,
									'max-w-[85%] md:max-w-[70%]'
								)}
							>
								<div class="prose prose-sm max-w-full overflow-x-auto">
									<MarkdownRenderer content={inputText} />
								</div>
							</div>
							<MessageActions
								text={inputText}
								timestamp={(inputMessage as { timestamp?: number } | null)?.timestamp ?? 0}
								align="right"
							/>
						</div>
					</div>
				)}

				{/* Nested messages section */}
				{nestedMessages.length > 0 &&
					(() => {
						// Find the index of the last assistant message with text content
						const lastAssistantIdx = nestedMessages.reduce(
							(acc, msg, idx) => (msg.type === 'assistant' ? idx : acc),
							-1
						);
						// Track seen texts for deduplication across nested messages
						const seenTexts = new Set<string>();

						// Only show last 3 renderable messages
						const MESSAGES_TO_SHOW = 3;
						const renderableIndices = nestedMessages.reduce<number[]>((acc, msg, idx) => {
							if (isRenderable(msg)) acc.push(idx);
							return acc;
						}, []);
						const lastRenderableSlice = renderableIndices.slice(-MESSAGES_TO_SHOW);
						const firstShownIdx =
							lastRenderableSlice.length > 0 ? lastRenderableSlice[0] : nestedMessages.length;
						const hasMore = firstShownIdx > 0;
						const messagesToRender = nestedMessages.slice(firstShownIdx);

						return (
							<div class="p-3">
								<div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
									Messages ({nestedMessages.length})
								</div>
								<div class="space-y-3">
									{hasMore && (
										<div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 py-1">
											<span class="flex-1 border-t border-gray-300 dark:border-gray-600"></span>
											<span class="shrink-0">({firstShownIdx}) more messages</span>
											<span class="flex-1 border-t border-gray-300 dark:border-gray-600"></span>
										</div>
									)}
									{messagesToRender.map((msg, idx) => {
										const actualIdx = firstShownIdx + idx;
										const isLastAssistant = actualIdx === lastAssistantIdx;
										return (
											<NestedMessageRenderer
												key={msg.uuid || `nested-${actualIdx}`}
												message={msg}
												toolResultsMap={EMPTY_TOOL_RESULTS}
												isLast={isLastAssistant}
												inputText={inputText}
												seenTexts={seenTexts}
											/>
										);
									})}
								</div>
							</div>
						);
					})()}

				{/* Turn timing footer */}
				{turn.startTime > 0 && (
					<div
						class={cn(
							'border-t bg-gray-50/80 dark:bg-gray-800/40 px-4 py-2.5 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400',
							colors.border
						)}
					>
						<span class="font-medium">{getMsgTime(turn.startTime)}</span>
						{turn.endTime && (
							<>
								<span class="text-gray-400 dark:text-gray-500">→</span>
								<span class="font-medium">{getMsgTime(turn.endTime)}</span>
								<span class="ml-auto font-mono tabular-nums">
									{formatDuration(turn.endTime - turn.startTime)}
								</span>
							</>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

export const AgentTurnBlock = memo(AgentTurnBlockInner);
