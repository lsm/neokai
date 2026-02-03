/**
 * SDKUserMessage Renderer
 *
 * Renders user messages from the SDK message stream
 */

import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { borderRadius, messageColors, messageSpacing } from '../../lib/design-tokens.ts';
import { toast } from '../../lib/toast.ts';
import { cn, copyToClipboard } from '../../lib/utils.ts';
import { Dropdown } from '../ui/Dropdown.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { Tooltip } from '../ui/Tooltip.tsx';
import { ErrorOutput, hasErrorOutput } from './ErrorOutput.tsx';
import { MessageInfoButton } from './MessageInfoButton.tsx';
import { MessageInfoDropdown } from './MessageInfoDropdown.tsx';
import { isHiddenCommandOutput, SlashCommandOutput } from './SlashCommandOutput.tsx';
import { SyntheticMessageBlock } from './SyntheticMessageBlock.tsx';

type UserMessage = Extract<SDKMessage, { type: 'user' }>;
type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

interface Props {
	message: UserMessage;
	onEdit?: () => void;
	onDelete?: () => void;
	sessionInfo?: SystemInitMessage; // Optional session init info to display
	isReplay?: boolean; // Whether this is a replay message (slash command response)
	sessionId?: string; // Session ID for rewind operations
}

export function SDKUserMessage({
	message,
	onEdit: _onEdit,
	onDelete: _onDelete,
	sessionInfo,
	isReplay,
	sessionId: _sessionId,
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

	// Extract image blocks from the message
	const getImageBlocks = (): Array<Record<string, unknown>> => {
		if (!Array.isArray(apiMessage.content)) return [];

		return apiMessage.content.filter((block: unknown) => {
			const b = block as Record<string, unknown>;
			return b.type === 'image';
		}) as Array<Record<string, unknown>>;
	};

	const textContent = getTextContent();
	const imageBlocks = getImageBlocks();

	// For synthetic messages, extract all content blocks for detailed display
	const getSyntheticContentBlocks = (): Array<Record<string, unknown>> | string | null => {
		if (!message.isSynthetic) return null;

		if (Array.isArray(apiMessage.content)) {
			return apiMessage.content.map((block: unknown) => {
				if (typeof block === 'object' && block !== null) {
					return block as Record<string, unknown>;
				}
				return { type: 'unknown', content: block };
			});
		}

		// For string content (like compact summaries), return the string directly
		if (typeof apiMessage.content === 'string') {
			return apiMessage.content;
		}

		return null;
	};

	const syntheticContentBlocks = getSyntheticContentBlocks();

	// Check if this is a slash command output (has <local-command-stdout> tags)
	const hasCommandOutput = (): boolean => {
		if (!isReplay) return false;
		return /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/.test(textContent);
	};

	// Check if this contains an error output (has <local-command-stderr> tags)
	// This can happen in both replay and synthetic messages (SDK injects errors as user messages)
	const containsErrorOutput = (): boolean => {
		return hasErrorOutput(textContent);
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

	// If this contains error output (<local-command-stderr>), render as error message
	// This takes priority over generic synthetic message rendering
	if (containsErrorOutput()) {
		return (
			<div class={cn(messageSpacing.assistant.container.combined)}>
				<ErrorOutput content={textContent} />
			</div>
		);
	}

	// If this is a synthetic message (compaction summary, interrupt, etc.), use the reusable component
	if (syntheticContentBlocks) {
		const messageWithTimestamp = message as SDKMessage & { timestamp?: number };
		return (
			<SyntheticMessageBlock
				content={syntheticContentBlocks}
				timestamp={messageWithTimestamp.timestamp}
				uuid={message.uuid}
			/>
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

					{/* Attached images */}
					{imageBlocks.length > 0 && (
						<div class="mt-3 space-y-2">
							{imageBlocks.map((img, idx) => {
								const source = img.source as Record<string, unknown>;
								const mediaType = source.media_type as string;
								const data = source.data as string;

								return (
									<div key={idx} class="rounded overflow-hidden border border-gray-600/50">
										<img
											src={`data:${mediaType};base64,${data}`}
											alt="Attached image"
											class="max-w-full h-auto"
										/>
									</div>
								);
							})}
						</div>
					)}

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
							trigger={<MessageInfoButton />}
							items={[]}
							customContent={<MessageInfoDropdown sessionInfo={sessionInfo} />}
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
