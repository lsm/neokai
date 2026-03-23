/**
 * AgentTurnBlock Component - Always-expanded turn summary with inline action items
 *
 * Similar visual style to SubagentBlock but:
 * - Always expanded (no expand/collapse toggle on the block itself)
 * - Shows the 3 most recent action items inline
 * - Each item shows: icon + action type + brief content
 * - Uses agent role colors for theming
 */

import type { JSX } from 'preact';
import { cn } from '../../lib/utils.ts';
import { ROLE_COLORS } from '../../lib/role-colors.ts';
import type { TurnBlock } from '../../hooks/useTurnBlocks';
import {
	isTextBlock,
	isThinkingBlock,
	isToolUseBlock,
	type ContentBlock,
} from '@neokai/shared/sdk/type-guards';
import { ToolIcon } from '../sdk/tools/ToolIcon.tsx';

interface AgentTurnBlockProps {
	turn: TurnBlock;
	className?: string;
}

type ItemType = 'tool' | 'thinking' | 'assistant' | 'user';

interface RenderItem {
	type: ItemType;
	toolName?: string;
	content: string;
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength - 3) + '...';
}

function getToolInputPreview(input: unknown): string {
	if (!input || typeof input !== 'object') return '';
	const obj = input as Record<string, unknown>;
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
	const json = JSON.stringify(input);
	if (json.length < 50) return json;
	return truncate(json, 40);
}

function ThinkingIcon({ className }: { className?: string }) {
	return (
		<svg class={cn('w-3.5 h-3.5', className)} fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
			/>
		</svg>
	);
}

function AssistantIcon({ className }: { className?: string }) {
	return (
		<svg class={cn('w-3.5 h-3.5', className)} fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
			/>
		</svg>
	);
}

function UserIcon({ className }: { className?: string }) {
	return (
		<svg class={cn('w-3.5 h-3.5', className)} fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
			/>
		</svg>
	);
}

/**
 * Extract up to 3 recent action items from turn messages.
 */
function extractRenderItems(turn: TurnBlock): RenderItem[] {
	const items: RenderItem[] = [];
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
						items.push({
							type: 'tool',
							toolName: toolBlock.name,
							content: getToolInputPreview(toolBlock.input) || '(no input)',
						});
					} else if (isThinkingBlock(block)) {
						const thinkingBlock = block as { thinking: string };
						items.push({
							type: 'thinking',
							content: truncate(thinkingBlock.thinking, 60),
						});
					} else if (isTextBlock(block)) {
						const textBlock = block as { text: string };
						const text = textBlock.text.trim();
						if (text.length > 0) {
							items.push({
								type: 'assistant',
								content: truncate(text, 60),
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
			if (typeof content === 'string' && content.trim()) {
				items.push({
					type: 'user',
					content: truncate(content.trim(), 60),
				});
			}
		}
	}

	return items.slice(0, 3);
}

function ToolCallItem({ toolName, content }: { toolName: string; content: string }) {
	return (
		<div class="flex items-start gap-2 py-1.5 px-2 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
			<ToolIcon toolName={toolName} size="sm" className="flex-shrink-0 mt-0.5" />
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-1.5">
					<span class="text-xs font-semibold text-blue-700 dark:text-blue-300">{toolName}</span>
				</div>
				<p class="text-xs text-blue-600 dark:text-blue-400 truncate mt-0.5">{content}</p>
			</div>
		</div>
	);
}

function ThinkingItem({ content }: { content: string }) {
	return (
		<div class="flex items-start gap-2 py-1.5 px-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
			<ThinkingIcon className="flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
			<div class="flex-1 min-w-0">
				<span class="text-xs font-semibold text-amber-700 dark:text-amber-300">Thinking</span>
				<p class="text-xs text-amber-600 dark:text-amber-400 truncate mt-0.5">{content}</p>
			</div>
		</div>
	);
}

function AssistantMessageItem({ content }: { content: string }) {
	return (
		<div class="flex items-start gap-2 py-1.5 px-2 rounded bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
			<AssistantIcon className="flex-shrink-0 mt-0.5 text-green-600 dark:text-green-400" />
			<div class="flex-1 min-w-0">
				<span class="text-xs font-semibold text-green-700 dark:text-green-300">Assistant</span>
				<p class="text-xs text-green-600 dark:text-green-400 truncate mt-0.5">{content}</p>
			</div>
		</div>
	);
}

function UserMessageItem({ content }: { content: string }) {
	return (
		<div class="flex items-start gap-2 py-1.5 px-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
			<UserIcon className="flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
			<div class="flex-1 min-w-0">
				<span class="text-xs font-semibold text-amber-700 dark:text-amber-300">User</span>
				<p class="text-xs text-amber-600 dark:text-amber-400 truncate mt-0.5">{content}</p>
			</div>
		</div>
	);
}

export function AgentTurnBlock({ turn, className }: AgentTurnBlockProps): JSX.Element {
	const items = extractRenderItems(turn);

	const roleConfig = ROLE_COLORS[turn.agentRole] ?? {
		border: 'border-l-slate-400',
		label: turn.agentRole,
		labelColor: 'text-slate-400',
	};

	// Parse the border color for use in the block
	const borderColorClass = roleConfig.border.replace('border-l-', 'border-');
	const headerBgClass = roleConfig.border.includes('teal')
		? 'bg-teal-50/50 dark:bg-teal-900/20'
		: roleConfig.border.includes('blue')
			? 'bg-blue-50/50 dark:bg-blue-900/20'
			: roleConfig.border.includes('purple')
				? 'bg-purple-50/50 dark:bg-purple-900/20'
				: roleConfig.border.includes('green')
					? 'bg-green-50/50 dark:bg-green-900/20'
					: 'bg-gray-50/50 dark:bg-gray-900/20';

	return (
		<div
			class={cn(
				'border rounded-lg overflow-hidden bg-white dark:bg-gray-900',
				borderColorClass,
				className
			)}
		>
			{/* Header with agent info */}
			<div
				class={cn(
					'flex items-center justify-between px-3 py-2 border-b',
					borderColorClass,
					headerBgClass
				)}
			>
				<div class="flex items-center gap-2 min-w-0 flex-1">
					{/* Agent icon */}
					<span class={cn('flex-shrink-0', roleConfig.labelColor)}>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
							/>
						</svg>
					</span>

					{/* Agent name */}
					<span class={cn('text-sm font-semibold truncate', roleConfig.labelColor)}>
						{turn.agentLabel || roleConfig.label}
					</span>
				</div>

				{/* Last action badge */}
				{turn.lastAction && (
					<span class="shrink-0 rounded px-2 py-0.5 text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
						{turn.lastAction}
					</span>
				)}
			</div>

			{/* Items list - always visible */}
			{items.length > 0 && (
				<div class="px-3 py-2 space-y-1.5 bg-white dark:bg-gray-900">
					{items.map((item, idx) => {
						if (item.type === 'tool') {
							return <ToolCallItem key={idx} toolName={item.toolName!} content={item.content} />;
						}
						if (item.type === 'thinking') {
							return <ThinkingItem key={idx} content={item.content} />;
						}
						if (item.type === 'assistant') {
							return <AssistantMessageItem key={idx} content={item.content} />;
						}
						if (item.type === 'user') {
							return <UserMessageItem key={idx} content={item.content} />;
						}
						return null;
					})}
				</div>
			)}
		</div>
	);
}
