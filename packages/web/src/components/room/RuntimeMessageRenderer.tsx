/**
 * RuntimeMessageRenderer
 *
 * Renders a single RuntimeMessage (status divider, rate_limited, model_fallback,
 * or leader_summary) inline between TurnSummaryBlocks in TaskViewV2.
 */

import MarkdownRenderer from '../chat/MarkdownRenderer';
import type { RuntimeMessage } from '../../hooks/useTurnBlocks';

interface Props {
	message: RuntimeMessage;
}

export function RuntimeMessageRenderer({ message: runtimeMsg }: Props) {
	const raw = runtimeMsg.message as Record<string, unknown>;

	if (raw.type === 'status') {
		const statusText = typeof raw.text === 'string' ? raw.text : 'Status update';
		return (
			<div data-testid="runtime-message" class="flex items-center gap-3 py-1.5">
				<div class="flex-1 h-px bg-dark-700" />
				<span class="text-xs text-gray-500 whitespace-nowrap">{statusText}</span>
				<div class="flex-1 h-px bg-dark-700" />
			</div>
		);
	}

	if (raw.type === 'rate_limited') {
		const text = typeof raw.text === 'string' ? raw.text : 'Rate limit reached';
		const resetsAt =
			typeof raw.resetsAt === 'number' ? new Date(raw.resetsAt).toLocaleTimeString() : null;
		const sessionRole = typeof raw.sessionRole === 'string' ? raw.sessionRole : '';
		const roleLabel =
			sessionRole === 'leader' ? 'Leader' : sessionRole === 'worker' ? 'Worker' : 'Agent';
		return (
			<div
				data-testid="runtime-message"
				class="my-2 rounded border border-amber-700/50 bg-amber-950/20 px-3 py-2"
			>
				<div class="flex items-center gap-2">
					<svg
						class="w-4 h-4 text-amber-400 flex-shrink-0"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
					<div class="flex-1 min-w-0">
						<p class="text-sm text-amber-300 font-medium">{roleLabel} rate limited</p>
						<p class="text-xs text-amber-400/80 mt-0.5">
							{text}
							{resetsAt ? ` Resets at ${resetsAt}.` : ''}
						</p>
					</div>
				</div>
			</div>
		);
	}

	if (raw.type === 'model_fallback') {
		const fromModel = typeof raw.fromModel === 'string' ? raw.fromModel : '';
		const toModel = typeof raw.toModel === 'string' ? raw.toModel : '';
		const sessionRole = typeof raw.sessionRole === 'string' ? raw.sessionRole : '';
		const roleLabel =
			sessionRole === 'leader' ? 'Leader' : sessionRole === 'worker' ? 'Worker' : 'Agent';
		return (
			<div
				data-testid="runtime-message"
				class="my-2 rounded border border-amber-700/50 bg-amber-950/20 px-3 py-2"
			>
				<div class="flex items-center gap-2">
					<svg
						class="w-4 h-4 text-amber-400 flex-shrink-0"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
					<div class="flex-1 min-w-0">
						<p class="text-sm text-amber-300 font-medium">{roleLabel} model switched</p>
						<p class="text-xs text-amber-400/80 mt-0.5">
							{fromModel || 'Previous model'} → {toModel || 'New model'}
						</p>
					</div>
				</div>
			</div>
		);
	}

	if (raw.type === 'leader_summary') {
		const rawText = typeof raw.text === 'string' ? raw.text : '';
		const summaryText = rawText.startsWith('[Turn Summary] ')
			? rawText.slice('[Turn Summary] '.length)
			: rawText;
		return (
			<div
				data-testid="runtime-message"
				class="my-1.5 rounded border border-purple-800/40 bg-purple-950/20 px-3 py-2"
			>
				<div class="flex items-center gap-1.5 mb-2">
					<svg
						class="w-3.5 h-3.5 text-purple-400 flex-shrink-0"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
						/>
					</svg>
					<span class="text-sm font-semibold text-purple-400">Turn Summary</span>
				</div>
				<MarkdownRenderer content={summaryText} class="text-sm text-gray-300" />
			</div>
		);
	}

	return null;
}
