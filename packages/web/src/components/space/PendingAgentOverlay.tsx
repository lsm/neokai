/**
 * PendingAgentOverlay — slide-over panel shown when the user opens a workflow
 * agent that has been declared in the workflow but has not yet spawned a
 * session. Triggered by `spaceOverlayPendingTaskIdSignal` /
 * `spaceOverlayPendingAgentNameSignal`.
 *
 * Behavior:
 *   - Renders a "Starting <agentName>…" header and a minimal composer.
 *   - On first send, calls `spaceStore.activateTaskNodeAgent(taskId, agentName,
 *     message)` — the daemon either short-circuits to the live session (if the
 *     agent already spawned) or queues the message and triggers a lazy
 *     activation kick.
 *   - The component watches `spaceStore.taskActivity` for a node-agent member
 *     whose `role === agentName`. When that member appears with a sessionId,
 *     the overlay hands off to `pushOverlayHistory(sessionId, agentName)`,
 *     which clears pending signals and switches the renderer to the standard
 *     `AgentOverlayChat`.
 *
 * Note: this composer is intentionally minimal — it does not support file
 * uploads, model switching, agent mentions, or autocomplete. Once the session
 * spawns, the overlay hands off to the full ChatContainer composer.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Portal } from '../ui/Portal';
import { setupFocusTrap } from '../ui/Modal';
import { spaceStore } from '../../lib/space-store';
import { pushOverlayHistory } from '../../lib/router';
import { cn } from '../../lib/utils';
import { borderColors } from '../../lib/design-tokens';

export const PENDING_AGENT_OVERLAY_TEST_ID = 'pending-agent-overlay';

interface PendingAgentOverlayProps {
	taskId: string;
	agentName: string;
	onClose: () => void;
}

export function PendingAgentOverlay({ taskId, agentName, onClose }: PendingAgentOverlayProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [content, setContent] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [waitingForSession, setWaitingForSession] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// Watch taskActivity for the live session matching this agentName.
	// Once we find one, hand off to the standard session-mode overlay so
	// ChatContainer can take over with full composer/history.
	const activityMembers = spaceStore.taskActivity.value.get(taskId) ?? [];
	const liveMember = useMemo(
		() => activityMembers.find((m) => m.kind === 'node_agent' && m.role === agentName),
		[activityMembers, agentName]
	);

	useEffect(() => {
		if (liveMember && liveMember.sessionId) {
			pushOverlayHistory(liveMember.sessionId, liveMember.label || agentName);
		}
	}, [liveMember, agentName]);

	// Close on Escape
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		document.addEventListener('keydown', handler);
		return () => document.removeEventListener('keydown', handler);
	}, [onClose]);

	// Focus trap
	useEffect(() => {
		if (panelRef.current) {
			return setupFocusTrap(panelRef.current);
		}
	}, []);

	// Autofocus the textarea on mount so the user can start typing immediately
	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const handleSend = async () => {
		const trimmed = content.trim();
		if (!trimmed || submitting) return;
		setSubmitting(true);
		setErrorMessage(null);
		try {
			const result = await spaceStore.activateTaskNodeAgent(taskId, agentName, trimmed);
			setContent('');
			// If the daemon returned a live session synchronously (already
			// spawned), pivot immediately. Otherwise, wait for the activity
			// subscription to surface the new session.
			if (result.sessionId) {
				pushOverlayHistory(result.sessionId, agentName);
			} else {
				setWaitingForSession(true);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setErrorMessage(`Failed to start ${agentName}: ${msg}`);
		} finally {
			setSubmitting(false);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		// Cmd/Ctrl + Enter or plain Enter (without shift) sends.
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void handleSend();
		}
	};

	return (
		<Portal into="body">
			<div
				class="fixed inset-0 z-50 flex justify-end"
				data-testid={PENDING_AGENT_OVERLAY_TEST_ID}
				aria-modal="true"
				role="dialog"
				aria-label={`${agentName} chat (starting)`}
			>
				{/* Backdrop */}
				<div
					class="absolute inset-0 bg-black/40 backdrop-blur-[1px] cursor-pointer"
					onClick={onClose}
					aria-hidden="true"
				/>

				{/* Slide-over panel */}
				<div
					ref={panelRef}
					class={cn(
						'relative flex flex-col h-full w-full max-w-2xl bg-dark-900 shadow-2xl',
						'border-l border-dark-700',
						'animate-slideInRight'
					)}
				>
					{/* Header */}
					<div
						class={cn(
							'px-4 min-h-[65px] flex-shrink-0 bg-dark-850 border-b flex items-center gap-3',
							borderColors.ui.default
						)}
					>
						<button
							type="button"
							onClick={onClose}
							class="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-dark-800 hover:text-gray-200 transition-colors flex-shrink-0"
							aria-label="Back"
						>
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M15 19l-7-7 7-7"
								/>
							</svg>
						</button>
						<div class="min-w-0 flex-1">
							<div class="text-sm font-medium text-gray-100 truncate">{agentName}</div>
							<div class="text-xs text-gray-500 truncate">
								{waitingForSession ? 'Starting session…' : 'Not started yet'}
							</div>
						</div>
					</div>

					{/* Body — message-area placeholder */}
					<div class="flex-1 min-h-0 overflow-auto px-4 py-6">
						<div
							class={cn(
								'mx-auto max-w-md text-center text-sm rounded-lg border bg-dark-850/60 px-4 py-6',
								borderColors.ui.default
							)}
							data-testid="pending-agent-overlay-body"
						>
							{waitingForSession ? (
								<>
									<div class="mb-3 flex items-center justify-center">
										<div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
									</div>
									<p class="text-gray-200 font-medium mb-1">Starting {agentName}…</p>
									<p class="text-gray-500">
										Your message has been queued. The session will open here as soon as the agent is
										ready.
									</p>
								</>
							) : (
								<>
									<p class="text-gray-200 font-medium mb-1">{agentName} hasn't started yet</p>
									<p class="text-gray-500">
										Send a message below to start this agent's session. Your first message will be
										delivered when the session is ready.
									</p>
								</>
							)}
						</div>
					</div>

					{/* Composer */}
					<div class={cn('flex-shrink-0 border-t bg-dark-900 px-3 py-3', borderColors.ui.default)}>
						{errorMessage && (
							<p class="mb-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300">
								{errorMessage}
							</p>
						)}
						<div class="flex gap-2">
							<textarea
								ref={textareaRef}
								class="flex-1 min-h-[44px] max-h-40 resize-none rounded-md bg-dark-850 border border-dark-700 text-sm text-gray-100 px-3 py-2 placeholder-gray-500 focus:outline-none focus:border-blue-500"
								placeholder={`Send first message to ${agentName}…`}
								value={content}
								onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
								onKeyDown={handleKeyDown}
								disabled={submitting || waitingForSession}
								data-testid="pending-agent-overlay-textarea"
								rows={2}
							/>
							<button
								type="button"
								onClick={() => void handleSend()}
								disabled={!content.trim() || submitting || waitingForSession}
								class={cn(
									'inline-flex items-center justify-center rounded-md px-3 text-sm font-medium transition-colors flex-shrink-0',
									'bg-blue-600 text-white hover:bg-blue-500',
									'disabled:bg-dark-700 disabled:text-gray-500 disabled:cursor-not-allowed'
								)}
								data-testid="pending-agent-overlay-send"
							>
								{submitting ? 'Starting…' : 'Send'}
							</button>
						</div>
					</div>
				</div>
			</div>
		</Portal>
	);
}
