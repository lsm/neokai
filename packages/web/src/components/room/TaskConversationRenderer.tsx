/**
 * TaskConversationRenderer
 *
 * Renders a flat chronological conversation timeline for a task group.
 * Subscribes to real-time message streaming via the useGroupMessages hook (LiveQuery).
 *
 * Each message is rendered inline with a thin colored left border indicating
 * which agent produced it. Role transitions show a small divider label.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import type { SessionInfo } from '@neokai/shared';
import { useMessageHub } from '../../hooks/useMessageHub';
import {
	useSessionQuestionState,
	type SessionQuestionState,
} from '../../hooks/useSessionQuestionState';
import { SDKMessageRenderer } from '../sdk/SDKMessageRenderer';
import { useMessageMaps } from '../../hooks/useMessageMaps';
import MarkdownRenderer from '../chat/MarkdownRenderer';
import { getModelLabel } from '../../lib/session-utils';
import { useGroupMessages } from '../../hooks/useGroupMessages';
import { parseGroupMessage, type TaskMeta } from '../../lib/parse-group-message';
import { ROLE_COLORS } from '../../lib/task-constants';

export { parseGroupMessage } from '../../lib/parse-group-message';

/** Empty question state used as a safe fallback for messages with unknown session IDs */
const NO_OP_QUESTION_STATE: SessionQuestionState = {
	pendingQuestion: null,
	resolvedQuestions: new Map(),
	onQuestionResolved: () => {},
};

interface TaskConversationRendererProps {
	groupId: string;
	/** Session ID of the leader agent (used to render AskUserQuestion as interactive forms) */
	leaderSessionId?: string;
	/** Session ID of the worker agent (used to render AskUserQuestion as interactive forms) */
	workerSessionId?: string;
	/** Called whenever the message list length changes, so the parent can drive autoscroll */
	onMessageCountChange?: (count: number) => void;
}

function getTaskMeta(msg: SDKMessage): TaskMeta | null {
	const meta = (msg as SDKMessage & { _taskMeta?: TaskMeta })._taskMeta;
	return meta ?? null;
}

export function TaskConversationRenderer({
	groupId,
	leaderSessionId,
	workerSessionId,
	onMessageCountChange,
}: TaskConversationRendererProps) {
	const { request } = useMessageHub();

	// Subscribe to question state for each agent session so AskUserQuestion
	// renders as an interactive form rather than a plain message
	const leaderQuestionState = useSessionQuestionState(leaderSessionId);
	const workerQuestionState = useSessionQuestionState(workerSessionId);

	// Subscribe to group messages via LiveQuery (handles initial snapshot + live deltas)
	const { messages: rawMessages, isLoading, isReconnecting } = useGroupMessages(groupId);

	const messages = useMemo(
		() => rawMessages.map(parseGroupMessage).filter((m): m is SDKMessage => m !== null),
		[rawMessages]
	);

	// Fetch session model info for leader and worker
	const [sessionModels, setSessionModels] = useState<{
		leaderModel: string | null;
		workerModel: string | null;
	}>({ leaderModel: null, workerModel: null });

	useEffect(() => {
		if (!leaderSessionId && !workerSessionId) return;
		let cancelled = false;
		const fetchSessionModels = async () => {
			try {
				const [leaderRes, workerRes] = await Promise.all([
					leaderSessionId
						? request<{ session: SessionInfo }>('session.get', { sessionId: leaderSessionId })
						: Promise.resolve({ session: null }),
					workerSessionId
						? request<{ session: SessionInfo }>('session.get', { sessionId: workerSessionId })
						: Promise.resolve({ session: null }),
				]);
				if (!cancelled) {
					setSessionModels({
						leaderModel: leaderRes.session?.config?.model ?? null,
						workerModel: workerRes.session?.config?.model ?? null,
					});
				}
			} catch {
				// Silently ignore — model names just won't be shown
			}
		};

		void fetchSessionModels();
		return () => {
			cancelled = true;
		};
	}, [leaderSessionId, workerSessionId, request]);

	// Build role divider labels that include model names for leader/worker
	function getRoleLabel(
		role: string,
		authorSessionId: string | undefined
	): { label: string; labelColor: string } {
		const base = ROLE_COLORS[role] ?? ROLE_COLORS.system;
		if (role === 'leader') {
			const modelLabel =
				authorSessionId === leaderSessionId ? getModelLabel(sessionModels.leaderModel) : '';
			return {
				label: modelLabel ? `Leader · ${modelLabel}` : 'Leader',
				labelColor: base.labelColor,
			};
		}
		if (role === 'lead') {
			const modelLabel =
				authorSessionId === leaderSessionId ? getModelLabel(sessionModels.leaderModel) : '';
			return {
				label: modelLabel ? `Lead · ${modelLabel}` : 'Lead',
				labelColor: base.labelColor,
			};
		}
		if (role === 'coder' || role === 'craft') {
			const modelLabel =
				authorSessionId === workerSessionId ? getModelLabel(sessionModels.workerModel) : '';
			return {
				label: modelLabel ? `${base.label} · ${modelLabel}` : base.label,
				labelColor: base.labelColor,
			};
		}
		return { label: base.label, labelColor: base.labelColor };
	}

	// Notify parent when message count changes so it can drive autoscroll
	useEffect(() => {
		onMessageCountChange?.(messages.length);
	}, [messages.length, onMessageCountChange]);

	const maps = useMessageMaps(messages, groupId);

	// Track role transitions to insert dividers
	const roleTransitions = useMemo(() => {
		const transitions = new Set<number>();
		let lastRole: string | null = null;
		for (let i = 0; i < messages.length; i++) {
			const meta = getTaskMeta(messages[i]);
			const role = meta?.authorRole ?? 'system';
			if (role !== 'system' && lastRole !== null && role !== lastRole) {
				transitions.add(i);
			}
			if (role !== 'system') lastRole = role;
		}
		return transitions;
	}, [messages]);

	if (isReconnecting) {
		return (
			<div class="flex-1 flex items-center justify-center">
				<p class="text-gray-400 text-sm">Reconnecting…</p>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div class="flex-1 flex items-center justify-center">
				<p class="text-gray-400 text-sm">Loading conversation…</p>
			</div>
		);
	}

	if (messages.length === 0) {
		return (
			<div class="flex-1 flex items-center justify-center">
				<div class="text-center px-6">
					<p class="text-gray-300 text-sm">No conversation history found for this task group.</p>
					<p class="text-gray-500 text-xs mt-1">
						No persisted timeline rows were found for this task group.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div class="px-4 py-3 space-y-0.5">
			{messages.map((msg, i) => {
				const meta = getTaskMeta(msg);
				const role = meta?.authorRole ?? 'system';
				const style = ROLE_COLORS[role] ?? ROLE_COLORS.system;
				const key = (msg as SDKMessage & { uuid?: string }).uuid ?? `msg-${groupId}-${i}`;

				// Status messages: render as centered dividers
				const raw = msg as Record<string, unknown>;
				if (raw.type === 'status') {
					const statusText = typeof raw.text === 'string' ? raw.text : 'Status update';
					return (
						<div key={key} class="flex items-center gap-3 py-1.5">
							<div class="flex-1 h-px bg-dark-700" />
							<span class="text-xs text-gray-500 whitespace-nowrap">{statusText}</span>
							<div class="flex-1 h-px bg-dark-700" />
						</div>
					);
				}

				// Rate limited event: render as an amber notification
				if (raw.type === 'rate_limited') {
					const text = typeof raw.text === 'string' ? raw.text : 'Rate limit reached';
					const resetsAt =
						typeof raw.resetsAt === 'number' ? new Date(raw.resetsAt).toLocaleTimeString() : null;
					const sessionRole = typeof raw.sessionRole === 'string' ? raw.sessionRole : '';
					const roleLabel =
						sessionRole === 'leader' ? 'Leader' : sessionRole === 'worker' ? 'Worker' : 'Agent';
					return (
						<div
							key={key}
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

				// Leader summary messages: render as a context card
				if (raw.type === 'leader_summary') {
					const rawText = typeof raw.text === 'string' ? raw.text : '';
					const summaryText = rawText.startsWith('[Turn Summary] ')
						? rawText.slice('[Turn Summary] '.length)
						: rawText;
					return (
						<div
							key={key}
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

				// Model fallback event: show a prominent amber notification about the model switch
				if (raw.type === 'model_fallback') {
					const fromModel = typeof raw.fromModel === 'string' ? raw.fromModel : '';
					const toModel = typeof raw.toModel === 'string' ? raw.toModel : '';
					const sessionRole = typeof raw.sessionRole === 'string' ? raw.sessionRole : '';
					const roleLabel =
						sessionRole === 'leader' ? 'Leader' : sessionRole === 'worker' ? 'Worker' : 'Agent';
					return (
						<div
							key={key}
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

				// Insert a role transition divider when the agent changes
				const showTransition = roleTransitions.has(i);

				// Look up the question state for the session that authored this message.
				// Fall back to a no-op state for messages whose authorSessionId does not
				// match either known session, to avoid rendering incorrect question forms.
				const authorSessionId = meta?.authorSessionId;
				let questionState: SessionQuestionState = NO_OP_QUESTION_STATE;
				if (authorSessionId && leaderSessionId && authorSessionId === leaderSessionId) {
					questionState = leaderQuestionState;
				} else if (authorSessionId && workerSessionId && authorSessionId === workerSessionId) {
					questionState = workerQuestionState;
				}

				// Get role label (includes model name for leader/worker/coder/craft roles)
				const roleLabel = getRoleLabel(role, authorSessionId);

				return (
					<div key={key}>
						{showTransition && (
							<div class="flex items-center gap-2 py-1.5 mt-1">
								<div class="flex-1 h-px bg-dark-700" />
								<span
									class={`text-[10px] font-semibold uppercase tracking-wide ${roleLabel.labelColor}`}
								>
									{roleLabel.label}
								</span>
								<div class="flex-1 h-px bg-dark-700" />
							</div>
						)}
						<div class={`border-l-2 ${style.border} pl-3`}>
							<SDKMessageRenderer
								message={msg}
								toolResultsMap={maps.toolResultsMap}
								toolInputsMap={maps.toolInputsMap}
								subagentMessagesMap={maps.subagentMessagesMap}
								sessionId={authorSessionId || undefined}
								pendingQuestion={questionState.pendingQuestion}
								resolvedQuestions={questionState.resolvedQuestions}
								onQuestionResolved={questionState.onQuestionResolved}
								taskContext
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
