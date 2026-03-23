/**
 * AgentTurnBlock Component - Always-expanded turn summary with inline action items
 *
 * Similar visual style to SubagentBlock but:
 * - Always expanded (no expand/collapse toggle)
 * - Shows the 3 most recent action items inline
 * - Each item shows: icon + action type + brief content
 * - Does not render Result/Error blocks at the end
 */

import type { JSX } from 'preact';
import { cn } from '../../lib/utils.ts';
import type { TurnBlock } from '../../hooks/useTurnBlocks';
import {
	isTextBlock,
	isThinkingBlock,
	isToolUseBlock,
	type ContentBlock,
} from '@neokai/shared/sdk/type-guards';

interface AgentTurnBlockProps {
	turn: TurnBlock;
	className?: string;
}

type ItemType = 'tool' | 'thinking' | 'assistant' | 'user' | 'system' | 'error';

interface RenderItem {
	type: ItemType;
	actionLabel: string; // e.g., "Bash", "Read", "Thinking"
	content: string; // e.g., "Get PR #12", "app/index.ts"
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
						d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
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

function getInputPreview(input: unknown): string {
	if (!input || typeof input !== 'object') return '';
	const obj = input as Record<string, unknown>;
	// Try to get a meaningful preview from common tool input fields
	if (obj.command && typeof obj.command === 'string') {
		return truncate(obj.command, 40);
	}
	if (obj.path && typeof obj.path === 'string') {
		return truncate(obj.path, 40);
	}
	if (obj.file_path && typeof obj.file_path === 'string') {
		return truncate(obj.file_path, 40);
	}
	if (obj.url && typeof obj.url === 'string') {
		return truncate(obj.url, 40);
	}
	if (obj.text && typeof obj.text === 'string') {
		return truncate(obj.text, 40);
	}
	// Fallback to JSON stringification of small objects
	const json = JSON.stringify(input);
	if (json.length < 50) return json;
	return truncate(json, 40);
}

/**
 * Extract up to 3 recent action items from turn messages.
 * Shows tool calls with name and args, thinking blocks, and assistant text.
 */
function extractRenderItems(turn: TurnBlock): RenderItem[] {
	const items: RenderItem[] = [];

	// If there's an error, show it first
	if (turn.isError && turn.errorMessage) {
		items.push({
			type: 'error',
			actionLabel: 'Error',
			content: truncate(turn.errorMessage, 60),
			isError: true,
		});
	}

	// Iterate through messages to extract items
	// We go backwards to find most recent items
	const messages = turn.messages;
	for (let i = messages.length - 1; i >= 0 && items.length < 3; i--) {
		const msg = messages[i];

		if (msg.type === 'assistant') {
			const assistantMsg = msg as {
				type: 'assistant';
				message: { content: ContentBlock[] };
			};
			const content = assistantMsg.message?.content;
			if (Array.isArray(content)) {
				for (let j = content.length - 1; j >= 0 && items.length < 3; j--) {
					const block = content[j];

					if (isToolUseBlock(block)) {
						const toolBlock = block as {
							type: 'tool_use';
							name: string;
							input: unknown;
						};
						const inputPreview = getInputPreview(toolBlock.input);
						items.push({
							type: 'tool',
							actionLabel: toolBlock.name,
							content: inputPreview || '(no input)',
						});
					} else if (isThinkingBlock(block)) {
						const thinkingBlock = block as { thinking: string };
						items.push({
							type: 'thinking',
							actionLabel: 'Thinking',
							content: truncate(thinkingBlock.thinking, 50),
						});
					} else if (isTextBlock(block)) {
						const textBlock = block as { text: string };
						const text = textBlock.text.trim();
						if (text.length > 0) {
							items.push({
								type: 'assistant',
								actionLabel: 'Assistant',
								content: truncate(text, 50),
							});
						}
					}
				}
			}
		} else if (msg.type === 'user') {
			const userMsg = msg as {
				type: 'user';
				message: { content: unknown };
			};
			const content = userMsg.message?.content;
			// Skip tool results (they're shown with tool_use blocks)
			if (typeof content === 'string' && content.trim()) {
				items.push({
					type: 'user',
					actionLabel: 'User',
					content: truncate(content.trim(), 50),
				});
			}
		}
	}

	// Reverse to show oldest first (so most recent is at the bottom visually)
	// Actually, let's keep it as most recent first for now
	return items.slice(0, 3);
}

export function AgentTurnBlock({ turn, className }: AgentTurnBlockProps): JSX.Element {
	const items = extractRenderItems(turn);
	const hasError = turn.isError;

	const roleConfig = {
		bg: 'bg-gray-50 dark:bg-gray-900/20',
		border: 'border-gray-200 dark:border-gray-700',
		text: 'text-gray-700 dark:text-gray-300',
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

			{/* Items list - always visible */}
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
									'font-semibold shrink-0',
									item.type === 'tool' && 'text-blue-600 dark:text-blue-400',
									item.type === 'thinking' && 'text-purple-600 dark:text-purple-400',
									item.type === 'assistant' && 'text-green-600 dark:text-green-400',
									item.type === 'user' && 'text-amber-600 dark:text-amber-400',
									item.isError && 'text-red-600 dark:text-red-400'
								)}
							>
								{item.actionLabel}
							</span>
							<span class="truncate">{item.content}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
