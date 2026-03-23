/**
 * AgentTurnBlock Component - Compact turn summary with recent actions
 *
 * Similar visual style to SubagentBlock but:
 * - Non-expandable (always shows collapsed preview)
 * - Shows only the 3 most recent actions/messages
 * - Each item shows: icon + type + brief content
 * - Does not render Result/Error blocks
 */

import type { JSX } from 'preact';
import { cn } from '../../lib/utils.ts';
import type { TurnBlock } from '../../hooks/useTurnBlocks';
import { isTextBlock, isThinkingBlock, type ContentBlock } from '@neokai/shared/sdk/type-guards';

interface AgentTurnBlockProps {
	turn: TurnBlock;
	className?: string;
}

type ItemType = 'tool' | 'thinking' | 'assistant' | 'user' | 'system' | 'error';

interface RenderItem {
	type: ItemType;
	label: string;
	content: string;
	isError?: boolean;
}

function getTypeIcon(type: ItemType): JSX.Element {
	switch (type) {
		case 'tool':
			return (
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
					/>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
					/>
				</svg>
			);
		case 'thinking':
			return (
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
					/>
				</svg>
			);
		case 'assistant':
			return (
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
					/>
				</svg>
			);
		case 'user':
			return (
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
					/>
				</svg>
			);
		case 'system':
			return (
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
					/>
				</svg>
			);
		case 'error':
			return (
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
			);
		default:
			return (
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
					/>
				</svg>
			);
	}
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength - 3) + '...';
}

/**
 * Extract items from turn messages for display
 */
function extractRenderItems(turn: TurnBlock): RenderItem[] {
	const items: RenderItem[] = [];

	// If there's an error, show it first
	if (turn.isError && turn.errorMessage) {
		items.push({
			type: 'error',
			label: 'Error',
			content: truncate(turn.errorMessage, 100),
			isError: true,
		});
	}

	// Build items from preview messages (last 3)
	// The preview shows the last message in the turn
	if (turn.previewMessage && turn.previewMessage.type === 'assistant') {
		const msg = turn.previewMessage as { type: 'assistant'; message: { content: unknown } };
		const content = msg.message?.content;
		if (content) {
			if (typeof content === 'string') {
				items.push({
					type: 'assistant',
					label: 'Assistant',
					content: truncate(content, 60),
				});
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (typeof block === 'object' && block !== null) {
						if (isThinkingBlock(block as ContentBlock)) {
							items.push({
								type: 'thinking',
								label: 'Thinking',
								content: truncate((block as { thinking: string }).thinking, 60),
							});
						} else if (isTextBlock(block as ContentBlock)) {
							items.push({
								type: 'assistant',
								label: 'Assistant',
								content: truncate((block as { text: string }).text, 60),
							});
						}
					}
				}
			}
		}
	}

	// Add tool calls if present (last one)
	if (turn.toolCallCount > 0) {
		// We don't have the actual tool call details in TurnBlock preview,
		// so we just indicate there were tool calls
		items.push({
			type: 'tool',
			label: 'Tool',
			content: `${turn.toolCallCount} tool call${turn.toolCallCount > 1 ? 's' : ''}`,
		});
	}

	// Return only the last 3 items
	return items.slice(-3);
}

export function AgentTurnBlock({ turn, className }: AgentTurnBlockProps): JSX.Element {
	const items = extractRenderItems(turn);
	const hasError = turn.isError;

	// Get role-based colors (reuse from ROLE_COLORS if available)
	const roleConfig = {
		bg: 'bg-gray-50 dark:bg-gray-900/20',
		border: 'border-gray-200 dark:border-gray-700',
		text: 'text-gray-700 dark:text-gray-300',
		badge: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
		icon: 'text-gray-600 dark:text-gray-400',
	};

	return (
		<div
			class={cn(
				'border rounded-lg overflow-hidden',
				hasError ? 'border-red-300 dark:border-red-800' : roleConfig.border,
				hasError ? 'bg-red-50 dark:bg-red-900/10' : roleConfig.bg,
				className
			)}
		>
			{/* Header */}
			<div class="flex items-center justify-between p-3">
				<div class="flex items-center gap-2 min-w-0 flex-1">
					{/* Agent icon */}
					<span class={cn('flex-shrink-0', hasError ? 'text-red-500' : roleConfig.icon)}>
						{hasError ? (
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
						) : (
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
								/>
							</svg>
						)}
					</span>

					{/* Agent name */}
					<span
						class={cn(
							'text-sm font-semibold truncate',
							hasError ? 'text-red-700 dark:text-red-300' : roleConfig.text
						)}
					>
						{turn.agentLabel || turn.agentRole}
					</span>
				</div>

				{/* Last action badge */}
				{turn.lastAction && (
					<span
						class={cn(
							'shrink-0 rounded px-2 py-0.5 text-xs font-medium',
							hasError
								? 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300'
								: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
						)}
					>
						{turn.lastAction}
					</span>
				)}
			</div>

			{/* Items list */}
			{items.length > 0 && (
				<div class="border-t border-gray-200 dark:border-gray-700 px-3 py-2 space-y-1.5">
					{items.map((item, idx) => (
						<div
							key={idx}
							class={cn(
								'flex items-start gap-2 text-xs',
								item.isError ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'
							)}
						>
							<span class="flex-shrink-0 mt-0.5">{getTypeIcon(item.type)}</span>
							<span
								class={cn(
									'font-medium shrink-0',
									item.isError ? 'text-red-700 dark:text-red-300' : ''
								)}
							>
								{item.label}:
							</span>
							<span class="truncate">{item.content}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
