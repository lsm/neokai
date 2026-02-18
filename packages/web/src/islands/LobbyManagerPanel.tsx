/**
 * LobbyManagerPanel - Collapsible overlay panel for Lobby Manager chat
 *
 * A right-side overlay panel for the Lobby Manager AI assistant.
 * Controlled by lobbyManagerOpenSignal.
 *
 * Features:
 * - Full-featured input with auto-resize, file attachments
 * - Auto-scroll with scroll button
 * - Cross-room AI assistant for managing workspaces
 */

import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { lobbyManagerStore } from '../lib/lobby-manager-store';
import { toast } from '../lib/toast';
import { lobbyManagerOpenSignal } from '../lib/signals';
import { IconButton } from '../components/ui/IconButton';
import { InputTextarea } from '../components/InputTextarea';
import { AttachmentPreview } from '../components/AttachmentPreview';
import { useFileAttachments, useAutoScroll } from '../hooks';
import type { LobbyManagerMessage } from '../lib/lobby-manager-store';

export function LobbyManagerPanel() {
	const [input, setInput] = useState('');
	const [sending, setSending] = useState(false);

	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const isOpen = lobbyManagerOpenSignal.value;
	const messages = lobbyManagerStore.messages.value;
	const loading = lobbyManagerStore.loading.value;

	// Initialize store when panel opens
	useEffect(() => {
		if (isOpen) {
			lobbyManagerStore.initialize();
		}
	}, [isOpen]);

	// File attachments hook
	const {
		attachments,
		fileInputRef,
		handleFileSelect,
		handleRemove,
		clear: clearAttachments,
		openFilePicker,
		getImagesForSend,
		handlePaste,
	} = useFileAttachments();

	// Auto-scroll hook
	const { showScrollButton, scrollToBottom } = useAutoScroll({
		containerRef: messagesContainerRef,
		endRef: messagesEndRef,
		enabled: true,
		messageCount: messages.length,
	});

	const handleSend = useCallback(async () => {
		const content = input.trim();
		if (!content || sending) return;

		try {
			setSending(true);

			// Get images if any (for future use)
			// const images = getImagesForSend();

			await lobbyManagerStore.sendMessage(content);

			// Clear input and attachments
			setInput('');
			clearAttachments();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to send');
		} finally {
			setSending(false);
		}
	}, [input, sending, getImagesForSend, clearAttachments]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				// Desktop: Enter submits, Shift+Enter for newline
				const isTouchDevice =
					window.matchMedia('(pointer: coarse)').matches ||
					('ontouchstart' in window && window.innerWidth < 768);

				if (!isTouchDevice && !e.shiftKey) {
					e.preventDefault();
					handleSend();
				}
			}
		},
		[handleSend]
	);

	const handleClose = () => {
		lobbyManagerOpenSignal.value = false;
	};

	return (
		<>
			{/* Backdrop for mobile */}
			{isOpen && <div class="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={handleClose} />}

			{/* Panel */}
			<div
				class={`
					fixed lg:relative
					right-0 top-0 h-full
					w-96
					bg-dark-950 border-l border-dark-700
					flex flex-col
					z-50 lg:z-auto
					transition-transform duration-300 ease-in-out
					${isOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0 lg:hidden'}
				`}
			>
				{/* Header */}
				<div class="px-4 py-3 border-b border-dark-700 flex items-center justify-between">
					<div class="flex items-center gap-3">
						<div>
							<h3 class="font-semibold text-gray-100">Lobby Manager</h3>
							<p class="text-xs text-gray-400">Cross-room AI assistant</p>
						</div>
					</div>
					<div class="flex items-center gap-2">
						<IconButton onClick={handleClose} title="Close panel" class="lg:hidden">
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M6 18L18 6M6 6l12 12"
								/>
							</svg>
						</IconButton>
					</div>
				</div>

				{/* Messages */}
				<div ref={messagesContainerRef} class="flex-1 overflow-y-auto p-4 space-y-4">
					{loading ? (
						<div class="text-center text-gray-400 py-8">
							<p>Loading chat history...</p>
						</div>
					) : messages.length === 0 ? (
						<div class="text-center text-gray-400 py-8">
							<p>Start a conversation with Lobby Manager</p>
							<p class="text-sm mt-2">
								Ask about rooms, sessions, or get help managing your workspaces.
							</p>
						</div>
					) : (
						messages.map((msg) => <LobbyMessage key={msg.id} message={msg} />)
					)}
					<div ref={messagesEndRef} />
				</div>

				{/* Scroll to bottom button */}
				{showScrollButton && (
					<div class="absolute bottom-24 right-4">
						<button
							onClick={() => scrollToBottom(true)}
							class="p-2 rounded-full bg-dark-700/90 text-gray-300 hover:bg-dark-600 shadow-lg transition-colors"
							title="Scroll to bottom"
						>
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M19 14l-7 7m0 0l-7-7m7 7V3"
								/>
							</svg>
						</button>
					</div>
				)}

				{/* Input */}
				<div class="p-3 border-t border-dark-700">
					{/* Attachment Preview */}
					{attachments.length > 0 && (
						<div class="mb-2">
							<AttachmentPreview attachments={attachments} onRemove={handleRemove} />
						</div>
					)}

					<div class="flex items-end gap-2">
						{/* Attach file button */}
						<button
							type="button"
							onClick={openFilePicker}
							disabled={sending}
							class="p-2 rounded-lg text-gray-400 hover:text-gray-300 hover:bg-dark-800 disabled:opacity-50 transition-colors"
							title="Attach image"
						>
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
								/>
							</svg>
						</button>

						{/* Hidden file input */}
						<input
							ref={fileInputRef}
							type="file"
							accept="image/png,image/jpeg,image/gif,image/webp"
							multiple
							onChange={handleFileSelect}
							class="hidden"
						/>

						{/* Input Textarea */}
						<InputTextarea
							content={input}
							onContentChange={setInput}
							onKeyDown={handleKeyDown}
							onSubmit={handleSend}
							disabled={sending}
							isAgentWorking={false}
							onPaste={sending ? undefined : handlePaste}
						/>
					</div>

					{/* Context indicator */}
					<div class="mt-2 flex items-center justify-between text-xs text-gray-500">
						<span></span>
						<span class="flex items-center gap-1">
							{attachments.length > 0 && (
								<span class="text-blue-400">{attachments.length} attachment(s)</span>
							)}
						</span>
					</div>
				</div>
			</div>
		</>
	);
}

function LobbyMessage({ message }: { message: LobbyManagerMessage }) {
	const isUser = message.role === 'user';

	return (
		<div class={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
			<div
				class={`max-w-[80%] rounded-lg px-3 py-2 ${
					isUser ? 'bg-blue-600 text-white' : 'bg-dark-800 text-gray-100'
				}`}
			>
				<p class="text-sm whitespace-pre-wrap">{message.content}</p>
				<p class="text-xs opacity-50 mt-1">{new Date(message.timestamp).toLocaleTimeString()}</p>
			</div>
		</div>
	);
}
