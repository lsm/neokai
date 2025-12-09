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
import { messageSpacing, messageColors, borderRadius } from '../../lib/design-tokens.ts';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';

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

	// Extract and parse slash command output (for replay messages)
	const getCommandOutput = (): string | null => {
		if (!isReplay) return null;

		const match = textContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
		return match ? match[1].trim() : null;
	};

	const commandOutput = getCommandOutput();

	// Check if this is a compact summary (replay message with long text content)
	const isCompactSummary = (): boolean => {
		return (isReplay ?? false) && !commandOutput && textContent.length > 200;
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

	// If this is a replay message with command output or compact summary, render it as assistant-style with markdown
	if (isReplay && (commandOutput || isCompactSummary())) {
		const contentToRender = commandOutput || textContent;
		const label = commandOutput ? 'command output' : 'conversation summary';

		return (
			<div class={cn(messageSpacing.assistant.container.combined)}>
				<div class="max-w-full">
					{/* Command output or compact summary card */}
					<div
						class={cn(
							'bg-dark-800/60 border border-dark-700/50 rounded-lg p-4',
							'prose prose-invert max-w-none'
						)}
					>
						<MarkdownRenderer content={contentToRender} class="text-sm" />
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

						<span class="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded">{label}</span>

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

	return (
		<div
			class={cn(messageSpacing.user.container.combined, 'flex justify-end')}
			data-testid="user-message"
			data-message-role="user"
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
