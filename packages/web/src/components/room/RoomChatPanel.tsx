/**
 * RoomChatPanel Component
 *
 * A chat interface for interacting with the room agent.
 * Provides a complete chat UI with message history, input area,
 * file attachments, and auto-scroll functionality.
 *
 * Uses the useChatBase hook for core chat functionality and
 * reuses existing UI components (InputTextarea, AttachmentPreview, IconButton).
 *
 * @example
 * ```tsx
 * <RoomChatPanel
 *   roomId="room-123"
 *   messages={roomStore.roomMessages}
 *   onSendMessage={handleSendMessage}
 *   title="Project Alpha"
 * />
 * ```
 */

import { Signal } from '@preact/signals';
import type { MessageImage } from '@neokai/shared';
import { useChatBase } from '../../hooks/useChatBase';
import { IconButton } from '../ui/IconButton';
import { InputTextarea } from '../InputTextarea';
import { AttachmentPreview } from '../AttachmentPreview';
import { cn } from '../../lib/utils';

/**
 * Message type for room chat
 */
export interface RoomChatMessage {
	/** Unique message identifier */
	id: string;
	/** Message sender role */
	role: 'user' | 'assistant' | 'system' | 'external_message';
	/** Message content (text) */
	content: string;
	/** Sender display name (optional) */
	senderName?: string;
	/** Message timestamp (milliseconds since epoch) */
	timestamp: number;
}

export interface RoomChatPanelProps {
	/** Room ID for this chat */
	roomId: string;
	/** Signal containing chat messages */
	messages: Signal<RoomChatMessage[]>;
	/** Handler for sending messages */
	onSendMessage: (content: string, images?: MessageImage[]) => Promise<void>;
	/** Optional room title displayed in header */
	title?: string;
	/** Optional close handler for modal usage */
	onClose?: () => void;
	/** Additional CSS classes */
	className?: string;
}

/**
 * Format timestamp to readable time string
 */
function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
	});
}

/**
 * Individual message component
 */
function ChatMessage({ message }: { message: RoomChatMessage }) {
	const isUser = message.role === 'user';
	const isSystem = message.role === 'system';
	const isExternal = message.role === 'external_message';

	return (
		<div class={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
			<div
				class={cn(
					'max-w-[85%] rounded-lg px-3 py-2',
					isUser
						? 'bg-blue-600 text-white'
						: isSystem
							? 'bg-dark-700 text-gray-400 text-xs'
							: isExternal
								? 'bg-purple-900/50 text-purple-100 border border-purple-700/50'
								: 'bg-dark-800 text-gray-100'
				)}
			>
				{/* Sender name for assistant/external messages */}
				{!isUser && !isSystem && (message.senderName || isExternal) && (
					<div class="text-xs font-medium mb-1 opacity-70 flex items-center gap-1">
						{isExternal && (
							<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
								<path
									fill-rule="evenodd"
									d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z"
									clip-rule="evenodd"
								/>
							</svg>
						)}
						{message.senderName || (isExternal ? 'External' : 'Agent')}
					</div>
				)}

				{/* Message content */}
				<p class="text-sm whitespace-pre-wrap">{message.content}</p>

				{/* Timestamp */}
				<p class={cn('text-xs mt-1', isUser ? 'text-blue-200' : 'opacity-50')}>
					{formatTime(message.timestamp)}
				</p>
			</div>
		</div>
	);
}

/**
 * Room chat panel with full messaging capabilities
 */
export function RoomChatPanel({
	roomId,
	messages,
	onSendMessage,
	title,
	onClose,
	className,
}: RoomChatPanelProps) {
	const {
		input,
		setInput,
		sending,
		sendMessage,
		handleKeyDown,
		attachments,
		fileInputRef,
		handleFileSelect,
		handleRemoveAttachment,
		openFilePicker,
		messagesContainerRef,
		messagesEndRef,
		showScrollButton,
		scrollToBottom,
		error,
		clearError,
	} = useChatBase<RoomChatMessage>({
		chatId: roomId,
		sendMessage: onSendMessage,
		messages,
	});

	return (
		<div class={cn('flex flex-col h-full bg-dark-950', className)}>
			{/* Header */}
			<div class="px-4 py-3 border-b border-dark-700 flex items-center justify-between shrink-0">
				<div class="flex items-center gap-3">
					<div>
						<h3 class="font-semibold text-gray-100">{title || 'Room Agent'}</h3>
						<p class="text-xs text-gray-400">
							{messages.value.length} message{messages.value.length !== 1 ? 's' : ''}
						</p>
					</div>
				</div>

				<div class="flex items-center gap-2">
					{/* Sending indicator */}
					{sending && (
						<div class="flex items-center gap-2 text-xs text-gray-400">
							<div class="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
							<span>Sending...</span>
						</div>
					)}

					{/* Close button (for modal usage) */}
					{onClose && (
						<IconButton onClick={onClose} title="Close chat" class="lg:hidden">
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M6 18L18 6M6 6l12 12"
								/>
							</svg>
						</IconButton>
					)}
				</div>
			</div>

			{/* Messages */}
			<div ref={messagesContainerRef} class="flex-1 overflow-y-auto p-4 space-y-3">
				{messages.value.length === 0 ? (
					<div class="text-center text-gray-400 py-8">
						<p>No messages yet</p>
						<p class="text-sm mt-2">Start a conversation with the room agent.</p>
					</div>
				) : (
					messages.value.map((msg) => <ChatMessage key={msg.id} message={msg} />)
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

			{/* Error display */}
			{error && (
				<div class="px-4 py-2 bg-red-900/30 border-t border-red-700/50 flex items-center justify-between">
					<span class="text-sm text-red-300">{error}</span>
					<button onClick={clearError} class="text-red-400 hover:text-red-300 transition-colors">
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>
			)}

			{/* Input area */}
			<div class="p-3 border-t border-dark-700 shrink-0">
				{/* Attachment preview */}
				{attachments.length > 0 && (
					<div class="mb-2">
						<AttachmentPreview attachments={attachments} onRemove={handleRemoveAttachment} />
					</div>
				)}

				<div class="flex items-end gap-2">
					{/* Attach file button */}
					<button
						type="button"
						onClick={openFilePicker}
						disabled={sending}
						class="p-2 rounded-lg text-gray-400 hover:text-gray-300 hover:bg-dark-800 disabled:opacity-50 transition-colors shrink-0"
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
						onSubmit={sendMessage}
						disabled={sending}
						isAgentWorking={false}
						onPaste={
							sending
								? undefined
								: (e) => {
										// Handle paste via handleInput pattern
										const clipboardData = e.clipboardData;
										if (clipboardData) {
											const text = clipboardData.getData('text');
											if (text) {
												setInput(input + text);
											}
										}
									}
						}
					/>
				</div>

				{/* Context indicator */}
				<div class="mt-2 flex items-center justify-between text-xs text-gray-500">
					<span>
						{attachments.length > 0 && (
							<span class="text-blue-400">{attachments.length} attachment(s)</span>
						)}
					</span>
					<span class="text-gray-600">Enter to send, Shift+Enter for newline</span>
				</div>
			</div>
		</div>
	);
}
