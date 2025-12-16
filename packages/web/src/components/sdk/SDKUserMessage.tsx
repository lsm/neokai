/**
 * SDKUserMessage Renderer
 *
 * Renders user messages from the SDK message stream
 */

import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import { IconButton } from '../ui/IconButton.tsx';
import { Dropdown } from '../ui/Dropdown.tsx';
import { Tooltip } from '../ui/Tooltip.tsx';
import { copyToClipboard } from '../../lib/utils.ts';
import { toast } from '../../lib/toast.ts';
import { cn } from '../../lib/utils.ts';
import { SessionIndicator } from './SessionIndicator.tsx';
import {
	messageSpacing,
	messageColors,
	borderRadius,
	borderColors,
} from '../../lib/design-tokens.ts';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';
import { SlashCommandOutput, isHiddenCommandOutput } from './SlashCommandOutput.tsx';

type UserMessage = Extract<SDKMessage, { type: 'user' }>;
type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

interface Props {
	message: UserMessage;
	onEdit?: () => void;
	onDelete?: () => void;
	sessionInfo?: SystemInitMessage; // Optional session init info to display
	isReplay?: boolean; // Whether this is a replay message (slash command response)
}

export function SDKUserMessage({
	message,
	onEdit: _onEdit,
	onDelete: _onDelete,
	sessionInfo,
	isReplay,
}: Props) {
	const { message: apiMessage } = message;

	// Check if this is a tool result message (should not be rendered as user message)
	const isToolResultMessage = (): boolean => {
		if (Array.isArray(apiMessage.content)) {
			return apiMessage.content.some(
				(block: unknown) => (block as Record<string, unknown>).type === 'tool_result'
			);
		}
		return false;
	};

	// Don't render tool result messages - they'll be shown with their tool use blocks
	if (isToolResultMessage()) {
		return null;
	}

	// Don't render hidden command outputs (e.g., "Compacted" is shown in CompactBoundaryMessage)
	if (isReplay) {
		const content = typeof apiMessage.content === 'string' ? apiMessage.content : '';
		if (isHiddenCommandOutput(content)) {
			return null;
		}
	}

	// Check if this is a synthetic compaction summary (should be rendered in CompactBoundaryMessage)
	const isSyntheticCompactionSummary = (): boolean => {
		if (!message.isSynthetic) return false;
		// Check content pattern
		const textContent = Array.isArray(apiMessage.content)
			? apiMessage.content
					.map((block: unknown) => {
						const b = block as Record<string, unknown>;
						if (b.type === 'text') return b.text as string;
						return '';
					})
					.filter(Boolean)
					.join('\n')
			: typeof apiMessage.content === 'string'
				? apiMessage.content
				: '';
		return textContent.startsWith('This session is being continued from a previous conversation');
	};

	// Skip rendering synthetic compaction summaries - they're shown in CompactBoundaryMessage
	if (isSyntheticCompactionSummary()) {
		return null;
	}

	// Extract text content from the message
	const getTextContent = (): string => {
		if (Array.isArray(apiMessage.content)) {
			return apiMessage.content
				.map((block: unknown) => {
					const b = block as Record<string, unknown>;
					// Text blocks
					if (b.type === 'text') {
						return b.text as string;
					}
					// Image blocks or other types - skip or show type
					return '';
				})
				.filter(Boolean)
				.join('\n');
		}
		if (typeof apiMessage.content === 'string') {
			return apiMessage.content;
		}
		return '';
	};

	const textContent = getTextContent();

	// For synthetic messages, extract all content blocks for detailed display
	const getSyntheticContentBlocks = (): Array<Record<string, unknown>> | null => {
		if (!message.isSynthetic) return null;

		if (Array.isArray(apiMessage.content)) {
			return apiMessage.content.map((block: unknown) => {
				if (typeof block === 'object' && block !== null) {
					return block as Record<string, unknown>;
				}
				return { type: 'unknown', content: block };
			});
		}

		return null;
	};

	const syntheticContentBlocks = getSyntheticContentBlocks();

	// Check if this is a slash command output (has <local-command-stdout> tags)
	const hasCommandOutput = (): boolean => {
		if (!isReplay) return false;
		return /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/.test(textContent);
	};

	// Check if this is a compact summary (replay message with long text content, no command tags)
	const isCompactSummary = (): boolean => {
		return (isReplay ?? false) && !hasCommandOutput() && textContent.length > 200;
	};

	const handleCopy = async () => {
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

	// If this is a replay message with command output, use SlashCommandOutput component
	if (isReplay && hasCommandOutput()) {
		return (
			<div class={cn(messageSpacing.assistant.container.combined)}>
				<SlashCommandOutput content={textContent} />
			</div>
		);
	}

	// If this is a compact summary (replay without command tags), render as markdown
	if (isCompactSummary()) {
		return (
			<div class={cn(messageSpacing.assistant.container.combined)}>
				<div class="max-w-full">
					{/* Compact summary card */}
					<div
						class={cn(
							`bg-dark-800/60 border ${borderColors.ui.default} rounded-lg p-4`,
							'prose prose-invert max-w-none'
						)}
					>
						<MarkdownRenderer content={textContent} class="text-sm" />
					</div>

					{/* Actions and timestamp */}
					<div
						class={cn(
							'flex items-center justify-start',
							messageSpacing.actions.gap,
							messageSpacing.actions.marginTop,
							messageSpacing.actions.padding
						)}
					>
						<Tooltip content={getFullTimestamp()} position="right">
							<span class="text-xs text-gray-500">{getTimestamp()}</span>
						</Tooltip>

						<span class="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded">
							conversation summary
						</span>

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
			</div>
		);
	}

	// If this is a synthetic message with multiple content blocks, render them in detail
	if (syntheticContentBlocks && syntheticContentBlocks.length > 0) {
		const messageWithTimestamp = message as SDKMessage & { timestamp?: number };
		return (
			<div
				class={cn(messageSpacing.user.container.combined, 'flex justify-end')}
				data-testid="user-message"
				data-message-role="user"
				data-message-uuid={message.uuid}
				data-message-timestamp={messageWithTimestamp.timestamp || 0}
			>
				<div class="max-w-[85%] md:max-w-[70%] w-auto">
					<div
						class={cn(
							'bg-purple-900/20 border border-purple-700/50 rounded-lg p-3',
							borderRadius.message.bubble
						)}
					>
						{/* Synthetic message label */}
						<div class="flex items-center gap-2 mb-2 pb-2 border-b border-purple-700/30">
							<svg
								class="w-4 h-4 text-purple-400"
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
							<span class="text-xs font-semibold text-purple-300">Synthetic Message</span>
						</div>

						{/* Render each content block */}
						<div class="space-y-2">
							{syntheticContentBlocks.map((block, idx) => (
								<div key={idx} class="text-sm">
									{block.type === 'text' && (
										<div class="text-gray-100 whitespace-pre-wrap">{block.text as string}</div>
									)}
									{block.type === 'image' && (
										<div class="space-y-1">
											<div class="text-xs text-purple-400">Image:</div>
											<div class="font-mono text-xs text-gray-300">
												{JSON.stringify(block, null, 2)}
											</div>
										</div>
									)}
									{block.type === 'tool_use' && (
										<div class="space-y-1">
											<div class="text-xs text-purple-400">Tool Use: {block.name as string}</div>
											<div class="font-mono text-xs text-gray-300 bg-gray-900/50 p-2 rounded">
												{JSON.stringify(block.input, null, 2)}
											</div>
										</div>
									)}
									{block.type === 'tool_result' && (
										<div class="space-y-1">
											<div class="text-xs text-purple-400">
												Tool Result: {(block.tool_use_id as string).slice(0, 12)}...
											</div>
											<div class="font-mono text-xs text-gray-300 bg-gray-900/50 p-2 rounded max-h-48 overflow-y-auto">
												{typeof block.content === 'string'
													? block.content
													: JSON.stringify(block.content, null, 2)}
											</div>
										</div>
									)}
									{!['text', 'image', 'tool_use', 'tool_result'].includes(block.type as string) && (
										<div class="space-y-1">
											<div class="text-xs text-purple-400">{block.type as string}:</div>
											<div class="font-mono text-xs text-gray-300 bg-gray-900/50 p-2 rounded">
												{JSON.stringify(block, null, 2)}
											</div>
										</div>
									)}
								</div>
							))}
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
						<Tooltip content={getFullTimestamp()} position="left">
							<span class="text-xs text-gray-500">{getTimestamp()}</span>
						</Tooltip>

						<Tooltip content="System-generated message" position="left">
							<span class="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded">
								synthetic
							</span>
						</Tooltip>

						<IconButton size="md" onClick={handleCopy} title="Copy message">
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
								/>
							</svg>
						</IconButton>
					</div>
				</div>
			</div>
		);
	}

	// Get message metadata for E2E tests
	const messageWithTimestamp = message as SDKMessage & { timestamp?: number };

	return (
		<div
			class={cn(messageSpacing.user.container.combined, 'flex justify-end')}
			data-testid="user-message"
			data-message-role="user"
			data-message-uuid={message.uuid}
			data-message-timestamp={messageWithTimestamp.timestamp || 0}
		>
			<div class="max-w-[85%] md:max-w-[70%] w-auto">
				{/* Message bubble */}
				<div
					class={cn(
						messageColors.user.background,
						borderRadius.message.bubble,
						messageSpacing.user.bubble.combined
					)}
				>
					{/* Main Content */}
					<div class={cn(messageColors.user.text, 'whitespace-pre-wrap break-words')}>
						{textContent}
					</div>

					{/* Parent tool use indicator (for sub-agent messages) */}
					{message.parent_tool_use_id && (
						<div class="mt-2 text-xs text-gray-500 dark:text-gray-400 italic">
							Sub-agent message (parent: {message.parent_tool_use_id.slice(0, 8)}...)
						</div>
					)}
				</div>

				{/* Actions and timestamp - outside the bubble, bottom right */}
				<div
					class={cn(
						'flex items-center justify-end',
						messageSpacing.actions.gap,
						messageSpacing.actions.marginTop,
						messageSpacing.actions.padding
					)}
				>
					<Tooltip content={getFullTimestamp()} position="left">
						<span class="text-xs text-gray-500">{getTimestamp()}</span>
					</Tooltip>

					{message.isSynthetic && (
						<Tooltip content="System-generated message" position="left">
							<span class="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded">
								synthetic
							</span>
						</Tooltip>
					)}

					{/* Session info icon (if session info is attached) */}
					{sessionInfo && (
						<Dropdown
							trigger={
								<IconButton size="md" title="Session info">
									<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
										/>
									</svg>
								</IconButton>
							}
							items={[]}
							customContent={<SessionIndicator sessionInfo={sessionInfo} />}
						/>
					)}

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
		</div>
	);
}
