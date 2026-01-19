/**
 * SyntheticMessageBlock Component
 *
 * Reusable component for rendering synthetic (system-generated) user messages.
 * Used for interrupt messages, compaction summaries, and other synthetic content.
 *
 * Features:
 * - Purple color scheme for visual distinction
 * - "Synthetic Message" header with icon
 * - Support for multiple content block types (text, image, tool_use, tool_result)
 * - Timestamp and synthetic badge in footer
 */

import { cn, copyToClipboard } from '../../lib/utils.ts';
import { messageSpacing, borderRadius } from '../../lib/design-tokens.ts';
import { Tooltip } from '../ui/Tooltip.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { toast } from '../../lib/toast.ts';

interface Props {
	/** Content to display - can be a simple string or array of content blocks */
	content: string | Array<Record<string, unknown>>;
	/** Optional timestamp in milliseconds */
	timestamp?: number;
	/** Optional UUID for data attributes */
	uuid?: string;
}

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
 * Synthetic Message Block - Renders system-generated user messages
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

	const handleCopy = async () => {
		const success = await copyToClipboard(getTextContent());
		if (success) {
			toast.success('Message copied to clipboard');
		} else {
			toast.error('Failed to copy message');
		}
	};

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
						{contentBlocks.map((block, idx) => (
							<div key={idx} class="text-sm">
								{block.type === 'text' && (
									<div class="text-gray-100 whitespace-pre-wrap break-words">
										{block.text as string}
									</div>
								)}
								{block.type === 'image' && (
									<div class="space-y-1">
										<div class="text-xs text-purple-400">Image:</div>
										<div class="font-mono text-xs text-gray-300 bg-gray-900/50 p-2 rounded overflow-x-auto">
											{JSON.stringify(block, null, 2)}
										</div>
									</div>
								)}
								{block.type === 'tool_use' && (
									<div class="space-y-1">
										<div class="text-xs text-purple-400">Tool Use: {block.name as string}</div>
										<div class="font-mono text-xs text-gray-300 bg-gray-900/50 p-2 rounded overflow-x-auto">
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
										<div class="font-mono text-xs text-gray-300 bg-gray-900/50 p-2 rounded max-h-48 overflow-auto">
											{block.content !== undefined && block.content !== null
												? typeof block.content === 'string'
													? block.content
													: JSON.stringify(block.content, null, 2)
												: '(empty)'}
										</div>
									</div>
								)}
								{!['text', 'image', 'tool_use', 'tool_result'].includes(block.type as string) && (
									<div class="space-y-1">
										<div class="text-xs text-purple-400">{block.type as string}:</div>
										<div class="font-mono text-xs text-gray-300 bg-gray-900/50 p-2 rounded overflow-x-auto">
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
