/**
 * SDKAssistantMessage Renderer
 *
 * Renders assistant messages with proper content array parsing:
 * - Text blocks (markdown)
 * - Tool use blocks (expandable with input/output)
 * - Thinking blocks (collapsible)
 */

import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import {
	isTextBlock,
	isToolUseBlock,
	isThinkingBlock,
	type ContentBlock,
} from '@liuboer/shared/sdk/type-guards';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { Tooltip } from '../ui/Tooltip.tsx';
import { copyToClipboard } from '../../lib/utils.ts';
import { toast } from '../../lib/toast.ts';
import { messageSpacing, messageColors, borderRadius } from '../../lib/design-tokens.ts';
import { cn } from '../../lib/utils.ts';
import { ToolResultCard } from './tools/index.ts';

type AssistantMessage = Extract<SDKMessage, { type: 'assistant' }>;

interface Props {
	message: AssistantMessage;
	toolResultsMap?: Map<string, unknown>;
}

export function SDKAssistantMessage({ message, toolResultsMap }: Props) {
	const { message: apiMessage } = message;

	// Extract text content for copy functionality
	const getTextContent = (): string => {
		return apiMessage.content
			.map((block: ContentBlock) => {
				if (isTextBlock(block)) {
					return block.text;
				}
				return '';
			})
			.filter(Boolean)
			.join('\n');
	};

	const handleCopy = async () => {
		const textContent = getTextContent();
		const success = await copyToClipboard(textContent);
		if (success) {
			toast.success('Message copied to clipboard');
		} else {
			toast.error('Failed to copy message');
		}
	};

	// Get timestamp from message
	const getTimestamp = (): string => {
		// Use the timestamp injected by the database (milliseconds since epoch)
		const messageWithTimestamp = message as SDKMessage & { timestamp?: number };
		const date = messageWithTimestamp.timestamp
			? new Date(messageWithTimestamp.timestamp)
			: new Date();
		return date.toLocaleTimeString([], {
			hour: '2-digit',
			minute: '2-digit',
		});
	};

	// Get full timestamp for tooltip
	const getFullTimestamp = (): string => {
		const messageWithTimestamp = message as SDKMessage & { timestamp?: number };
		const date = messageWithTimestamp.timestamp
			? new Date(messageWithTimestamp.timestamp)
			: new Date();
		return date.toLocaleString();
	};

	// Separate blocks by type - tool use and thinking blocks get full width, text blocks are constrained
	const textBlocks = apiMessage.content.filter((block: ContentBlock) => isTextBlock(block));
	const toolBlocks = apiMessage.content.filter((block: ContentBlock) => isToolUseBlock(block));
	const thinkingBlocks = apiMessage.content.filter((block: ContentBlock) => isThinkingBlock(block));

	return (
		<div class="py-2 space-y-3" data-testid="assistant-message" data-message-role="assistant">
			{/* Tool use blocks - full width like result messages */}
			{toolBlocks.map((block: Extract<ContentBlock, { type: 'tool_use' }>, idx: number) => {
				const toolResult = toolResultsMap?.get(block.id);
				return <ToolUseBlock key={`tool-${idx}`} block={block} toolResult={toolResult} />;
			})}

			{/* Thinking blocks - treated as tool blocks for unified UI */}
			{thinkingBlocks.map((block: Extract<ContentBlock, { type: 'thinking' }>, idx: number) => (
				<ToolResultCard
					key={`thinking-${idx}`}
					toolName="Thinking"
					toolId={`thinking-${idx}`}
					input={block.thinking}
					output={null}
					isError={false}
					variant="default"
				/>
			))}

			{/* Text blocks - full width like tool results */}
			{textBlocks.length > 0 && (
				<div class="w-full">
					<div
						class={cn(
							messageColors.assistant.background,
							borderRadius.message.bubble,
							messageSpacing.assistant.bubble.combined,
							'space-y-3'
						)}
					>
						{textBlocks.map((block: Extract<ContentBlock, { type: 'text' }>, idx: number) => (
							<div key={idx} class={messageColors.assistant.text}>
								<MarkdownRenderer
									content={block.text}
									class="dark:prose-invert max-w-none prose-pre:bg-gray-900 prose-pre:text-gray-100"
								/>
							</div>
						))}

						{/* Parent tool use indicator (for sub-agent messages) */}
						{message.parent_tool_use_id && (
							<div class="text-xs text-gray-500 dark:text-gray-400 italic">
								Sub-agent response (parent: {message.parent_tool_use_id.slice(0, 8)}...)
							</div>
						)}
					</div>

					{/* Actions and timestamp - bottom left */}
					<div
						class={cn(
							'flex items-center',
							messageSpacing.actions.gap,
							messageSpacing.actions.marginTop,
							messageSpacing.actions.padding
						)}
					>
						<Tooltip content={getFullTimestamp()} position="right">
							<span class="text-xs text-gray-500">{getTimestamp()}</span>
						</Tooltip>

						<IconButton size="md" onClick={handleCopy} title="Copy message">
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
								/>
							</svg>
						</IconButton>
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * Tool Use Block Component
 * Now uses the new ToolResultCard component
 */
function ToolUseBlock({
	block,
	toolResult,
}: {
	block: Extract<ContentBlock, { type: 'tool_use' }>;
	toolResult?: unknown;
}) {
	return (
		<ToolResultCard
			toolName={block.name}
			toolId={block.id}
			input={block.input}
			output={toolResult}
			isError={(toolResult as unknown)?.is_error || false}
			variant="default"
		/>
	);
}

// ============================================================================
// LEGACY CODE BELOW - KEPT FOR REFERENCE, CAN BE REMOVED AFTER TESTING
// ============================================================================
