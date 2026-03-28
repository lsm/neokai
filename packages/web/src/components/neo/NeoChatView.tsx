/**
 * NeoChatView
 *
 * The main chat interface inside the Neo panel.
 * - Renders user messages and Neo (assistant) responses
 * - Auto-scrolls to the newest message
 * - Renders structured JSON responses as formatted cards
 * - Shows inline NeoConfirmationCard when Neo needs user input
 * - Displays error states as styled cards (not alerts/modals)
 * - Input bar at the bottom
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { neoStore, type NeoMessage } from '../../lib/neo-store.ts';
import { NeoConfirmationCard } from './NeoConfirmationCard.tsx';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';

// ---------------------------------------------------------------------------
// Error state helpers
// ---------------------------------------------------------------------------

type ErrorCode = 'provider_unavailable' | 'no_credentials' | 'model_unavailable' | string;

interface ErrorCardProps {
	errorCode: ErrorCode;
	onDismiss: () => void;
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
	return (
		<button
			type="button"
			onClick={onDismiss}
			data-testid="neo-error-dismiss"
			aria-label="Dismiss error"
			class="ml-auto p-0.5 rounded text-current opacity-60 hover:opacity-100 transition-opacity"
		>
			<svg
				class="w-3 h-3"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={2}
				aria-hidden="true"
			>
				<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
			</svg>
		</button>
	);
}

function ErrorCard({ errorCode, onDismiss }: ErrorCardProps) {
	if (errorCode === 'no_credentials') {
		return (
			<div
				data-testid="neo-error-no-credentials"
				class="my-2 rounded-xl border border-amber-700/40 bg-amber-950/20 px-3 py-2.5"
			>
				<div class="flex items-start gap-1">
					<div class="flex-1 min-w-0">
						<p class="text-sm font-medium text-amber-300">API key not configured</p>
						<p class="text-xs text-amber-400/80 mt-0.5">
							Please set up your provider in{' '}
							<a href="/settings" class="underline hover:text-amber-300 transition-colors">
								Settings
							</a>
							.
						</p>
					</div>
					<DismissButton onDismiss={onDismiss} />
				</div>
			</div>
		);
	}
	if (errorCode === 'model_unavailable') {
		return (
			<div
				data-testid="neo-error-model-unavailable"
				class="my-2 rounded-xl border border-amber-700/40 bg-amber-950/20 px-3 py-2.5"
			>
				<div class="flex items-start gap-1">
					<div class="flex-1 min-w-0">
						<p class="text-sm font-medium text-amber-300">Model unavailable</p>
						<p class="text-xs text-amber-400/80 mt-0.5">
							The selected model is not available. Please update Neo&apos;s model in{' '}
							<a href="/settings" class="underline hover:text-amber-300 transition-colors">
								Settings
							</a>
							.
						</p>
					</div>
					<DismissButton onDismiss={onDismiss} />
				</div>
			</div>
		);
	}
	// Default: provider_unavailable or unknown
	return (
		<div
			data-testid="neo-error-provider-unavailable"
			class="my-2 rounded-xl border border-gray-700 bg-gray-800/60 px-3 py-2.5"
		>
			<div class="flex items-start gap-1">
				<div class="flex-1 min-w-0">
					<p class="text-sm font-medium text-gray-300">Neo is temporarily unavailable</p>
					<p class="text-xs text-gray-500 mt-0.5">Please try again.</p>
				</div>
				<DismissButton onDismiss={onDismiss} />
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Message content parsers
// ---------------------------------------------------------------------------

/** Extract displayable text from a raw SDK message content JSON string. */
function extractTextContent(content: string): string {
	try {
		const parsed: unknown = JSON.parse(content);
		if (typeof parsed === 'string') return parsed;
		// SDK messages use content arrays: [{ type: 'text', text: '...' }, ...]
		if (Array.isArray(parsed)) {
			return parsed
				.filter(
					(block): block is { type: string; text: string } =>
						typeof block === 'object' &&
						block !== null &&
						'type' in block &&
						(block as { type: string }).type === 'text' &&
						'text' in block
				)
				.map((block) => block.text)
				.join('\n');
		}
		// Fallback: some messages store content as a direct string field
		if (typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
			const text = (parsed as { text: unknown }).text;
			if (typeof text === 'string') return text;
		}
		return '';
	} catch {
		return content;
	}
}

/** Try to parse content as structured JSON data (object/array). Returns null if plain text. */
function tryParseStructured(content: string): unknown | null {
	try {
		const parsed: unknown = JSON.parse(content);
		if (Array.isArray(parsed)) return parsed;
		if (typeof parsed === 'object' && parsed !== null) return parsed;
		return null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Structured data renderer
// ---------------------------------------------------------------------------

function StructuredDataCard({ data }: { data: unknown }) {
	const [expanded, setExpanded] = useState(false);

	if (Array.isArray(data)) {
		return (
			<div class="my-1 rounded-lg border border-gray-700 overflow-hidden text-xs">
				<div
					class="flex items-center justify-between px-2 py-1.5 bg-gray-800/80 cursor-pointer hover:bg-gray-700/60 transition-colors"
					onClick={() => setExpanded((v) => !v)}
				>
					<span class="text-gray-400 font-medium">
						Array ({data.length} item{data.length !== 1 ? 's' : ''})
					</span>
					<svg
						class={`w-3 h-3 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth={2}
						aria-hidden="true"
					>
						<path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
					</svg>
				</div>
				{expanded && (
					<div class="overflow-x-auto">
						<table class="w-full text-xs">
							<tbody>
								{data.map((item, i) => (
									<tr key={i} class="border-t border-gray-700/50 hover:bg-gray-800/40">
										<td class="px-2 py-1 text-gray-600 font-mono w-8">{i}</td>
										<td class="px-2 py-1 text-gray-300 font-mono whitespace-pre-wrap break-all">
											{typeof item === 'object' ? JSON.stringify(item, null, 2) : String(item)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		);
	}

	// Plain object
	const entries = Object.entries(data as Record<string, unknown>);
	return (
		<div class="my-1 rounded-lg border border-gray-700 overflow-hidden text-xs">
			<div
				class="flex items-center justify-between px-2 py-1.5 bg-gray-800/80 cursor-pointer hover:bg-gray-700/60 transition-colors"
				onClick={() => setExpanded((v) => !v)}
			>
				<span class="text-gray-400 font-medium">Structured data</span>
				<svg
					class={`w-3 h-3 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					aria-hidden="true"
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
				</svg>
			</div>
			{expanded && (
				<div class="overflow-x-auto">
					<table class="w-full text-xs">
						<tbody>
							{entries.map(([k, v]) => (
								<tr key={k} class="border-t border-gray-700/50 hover:bg-gray-800/40">
									<td class="px-2 py-1 text-gray-500 font-mono whitespace-nowrap align-top">{k}</td>
									<td class="px-2 py-1 text-gray-300 font-mono whitespace-pre-wrap break-all">
										{typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Individual message bubble
// ---------------------------------------------------------------------------

interface MessageBubbleProps {
	msg: NeoMessage;
	pendingActionId?: string | null;
	/** Whether this is the last assistant message — only this one renders the confirmation card. */
	isLastAssistant?: boolean;
}

function MessageBubble({ msg, pendingActionId, isLastAssistant }: MessageBubbleProps) {
	const isUser = msg.messageType === 'user';
	const isResult = msg.messageType === 'result';
	const isSystem = msg.messageType === 'system';

	// Skip internal result/system messages in this simplified view
	if (isResult || isSystem) return null;

	const rawText = extractTextContent(msg.content);

	// Only the last assistant message should render the confirmation card.
	const hasPendingConfirmation = !isUser && isLastAssistant && pendingActionId;

	if (isUser) {
		return (
			<div data-testid="neo-user-message" class="flex justify-end mb-3">
				<div class="max-w-[85%] bg-blue-600 text-white rounded-[20px] rounded-br-md px-3.5 py-2 text-sm leading-relaxed break-words">
					{rawText}
				</div>
			</div>
		);
	}

	// Assistant message
	const structured = rawText ? null : tryParseStructured(msg.content);

	return (
		<div data-testid="neo-assistant-message" class="mb-3">
			{/* Sparkle avatar */}
			<div class="flex items-start gap-2">
				<div class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-600/20 border border-violet-500/30 flex items-center justify-center mt-0.5">
					<svg
						class="w-3 h-3 text-violet-400"
						viewBox="0 0 24 24"
						fill="currentColor"
						aria-hidden="true"
					>
						<path d="M12 2l2.09 6.41L20.5 10l-6.41 2.09L12 18.5l-2.09-6.41L4 10l6.41-2.09L12 2z" />
					</svg>
				</div>
				<div class="flex-1 min-w-0">
					{rawText && (
						<div class="text-sm text-gray-200 leading-relaxed">
							<MarkdownRenderer content={rawText} class="text-sm text-gray-200" />
						</div>
					)}
					{structured && <StructuredDataCard data={structured} />}
					{hasPendingConfirmation && (
						<NeoConfirmationCard
							actionId={pendingActionId}
							description={neoStore.pendingConfirmation.value?.description ?? ''}
							riskLevel={neoStore.pendingConfirmation.value?.riskLevel}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Loading indicator
// ---------------------------------------------------------------------------

function TypingIndicator() {
	return (
		<div data-testid="neo-typing-indicator" class="flex items-start gap-2 mb-3">
			<div class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-600/20 border border-violet-500/30 flex items-center justify-center">
				<svg
					class="w-3 h-3 text-violet-400"
					viewBox="0 0 24 24"
					fill="currentColor"
					aria-hidden="true"
				>
					<path d="M12 2l2.09 6.41L20.5 10l-6.41 2.09L12 18.5l-2.09-6.41L4 10l6.41-2.09L12 2z" />
				</svg>
			</div>
			<div class="flex items-center gap-1 py-1.5 px-1">
				{[0, 1, 2].map((i) => (
					<span
						key={i}
						class="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce"
						style={{ animationDelay: `${i * 150}ms` }}
					/>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// NeoChatView
// ---------------------------------------------------------------------------

export function NeoChatView() {
	const [inputValue, setInputValue] = useState('');
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<{ code: string; message: string } | null>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const messages = neoStore.messages.value;
	const loading = neoStore.loading.value;
	const pendingConfirmation = neoStore.pendingConfirmation.value;

	// Auto-scroll to newest message — depend on last message id so updates trigger correctly
	const lastMessageId = messages[messages.length - 1]?.id;
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [lastMessageId]);

	// Focus input when the panel opens
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSend = async () => {
		const text = inputValue.trim();
		if (!text || sending) return;

		setSendError(null);
		setSending(true);

		try {
			const result = await neoStore.sendMessage(text);
			if (result.success) {
				// Only clear input on success so the user can retry on failure
				setInputValue('');
			} else {
				setSendError({
					code: result.errorCode ?? 'provider_unavailable',
					message: result.error ?? 'Failed to send message',
				});
			}
		} finally {
			setSending(false);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const isEmpty = messages.length === 0 && !loading;

	return (
		<div class="flex flex-col h-full min-h-0" data-testid="neo-chat-view">
			{/* Message list */}
			<div class="flex-1 min-h-0 overflow-y-auto px-3 py-3 scroll-smooth">
				{/* Empty state */}
				{isEmpty && (
					<div
						data-testid="neo-empty-state"
						class="flex flex-col items-center justify-center h-full gap-3 text-center px-4"
					>
						<div class="w-10 h-10 rounded-full bg-violet-600/20 border border-violet-500/30 flex items-center justify-center">
							<svg
								class="w-5 h-5 text-violet-400"
								viewBox="0 0 24 24"
								fill="currentColor"
								aria-hidden="true"
							>
								<path d="M12 2l2.09 6.41L20.5 10l-6.41 2.09L12 18.5l-2.09-6.41L4 10l6.41-2.09L12 2z" />
								<path
									d="M5 3l.75 2.25L8 6l-2.25.75L5 9l-.75-2.25L2 6l2.25-.75L5 3z"
									opacity={0.5}
								/>
							</svg>
						</div>
						<div>
							<p class="text-sm font-medium text-gray-300">Hi, I&apos;m Neo</p>
							<p class="text-xs text-gray-500 mt-1">
								Ask me anything about your rooms, sessions, or goals.
							</p>
						</div>
					</div>
				)}

				{/* Messages */}
				{(() => {
					// Find the last assistant message so only it renders the confirmation card
					const lastAssistantIdx = messages.reduce(
						(last, m, i) => (m.messageType === 'assistant' ? i : last),
						-1
					);
					return messages.map((msg, i) => (
						<MessageBubble
							key={msg.id}
							msg={msg}
							pendingActionId={pendingConfirmation?.actionId}
							isLastAssistant={i === lastAssistantIdx}
						/>
					));
				})()}

				{/* Typing indicator when sending */}
				{sending && <TypingIndicator />}

				{/* Send error */}
				{sendError && <ErrorCard errorCode={sendError.code} onDismiss={() => setSendError(null)} />}

				{/* Scroll anchor */}
				<div ref={messagesEndRef} />
			</div>

			{/* Input bar */}
			<div class="flex-shrink-0 border-t border-gray-700 px-3 py-2.5 bg-gray-900/50">
				<div class="flex items-end gap-2">
					<textarea
						ref={inputRef}
						data-testid="neo-chat-input"
						value={inputValue}
						onInput={(e) => setInputValue((e.target as HTMLTextAreaElement).value)}
						onKeyDown={handleKeyDown}
						placeholder="Ask Neo…"
						rows={1}
						disabled={sending}
						class="flex-1 resize-none bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors disabled:opacity-50 min-h-[36px] max-h-[120px] overflow-y-auto"
						style="field-sizing: content;"
					/>
					<button
						data-testid="neo-send-button"
						onClick={handleSend}
						disabled={sending || !inputValue.trim()}
						aria-label="Send message"
						class="flex-shrink-0 w-8 h-8 rounded-xl bg-violet-600 hover:bg-violet-500 text-white flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					>
						<svg
							class="w-4 h-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
							/>
						</svg>
					</button>
				</div>
			</div>
		</div>
	);
}
