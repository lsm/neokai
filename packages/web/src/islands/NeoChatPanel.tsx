/**
 * NeoChatPanel - Collapsible overlay panel for Neo chat
 *
 * A right-side overlay panel for the AI orchestrator chat.
 * Controlled by neoChatOpenSignal.
 *
 * Features:
 * - Full-featured input with auto-resize, file attachments
 * - Model/provider switching (simplified, no persistence)
 * - Thinking mode toggle
 * - Auto-scroll with scroll button
 */

import { useState, useCallback, useRef } from 'preact/hooks';
import { roomStore } from '../lib/room-store';
import { toast } from '../lib/toast';
import { neoChatOpenSignal } from '../lib/signals';
import { IconButton } from '../components/ui/IconButton';
import { InputTextarea } from '../components/InputTextarea';
import { AttachmentPreview } from '../components/AttachmentPreview';
import { useFileAttachments, useAutoScroll } from '../hooks';
import type { NeoContextMessage } from '@neokai/shared';

// Available models for Neo (simplified list)
const NEO_MODELS = [
	{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', family: 'sonnet' },
	{ id: 'claude-opus-4-20250514', name: 'Claude Opus 4', family: 'opus' },
	{ id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', family: 'haiku' },
	{ id: 'glm-4-plus', name: 'GLM-4 Plus', family: 'glm' },
];

type NeoModelId = (typeof NEO_MODELS)[number]['id'];

const MODEL_FAMILY_ICONS: Record<string, string> = {
	opus: 'O',
	sonnet: 'S',
	haiku: 'H',
	glm: 'G',
};

export function NeoChatPanel() {
	const [input, setInput] = useState('');
	const [sending, setSending] = useState(false);
	const [selectedModel, setSelectedModel] = useState<NeoModelId>(NEO_MODELS[0].id);
	const [thinkingMode, setThinkingMode] = useState(false);
	const [showModelMenu, setShowModelMenu] = useState(false);

	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const isOpen = neoChatOpenSignal.value;
	const messages = roomStore.neoMessages.value;

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

			// Get images if any (for future use when roomStore supports images)
			// const images = getImagesForSend();

			// Send message - roomStore.sendNeoMessage currently only accepts content
			await roomStore.sendNeoMessage(content);

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
		neoChatOpenSignal.value = false;
	};

	const currentModel = NEO_MODELS.find((m) => m.id === selectedModel) || NEO_MODELS[0];

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
							<h3 class="font-semibold text-gray-100">Neo</h3>
							<p class="text-xs text-gray-400">AI Orchestrator</p>
						</div>
					</div>
					<div class="flex items-center gap-2">
						{/* Thinking Mode Toggle */}
						<button
							onClick={() => setThinkingMode(!thinkingMode)}
							title={thinkingMode ? 'Disable thinking mode' : 'Enable thinking mode'}
							class={`p-1.5 rounded-md transition-colors ${
								thinkingMode
									? 'bg-purple-600/20 text-purple-400'
									: 'text-gray-400 hover:text-gray-300'
							}`}
						>
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
								/>
							</svg>
						</button>

						{/* Model Switcher */}
						<div class="relative">
							<button
								onClick={() => setShowModelMenu(!showModelMenu)}
								class="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-dark-800 text-gray-300 hover:bg-dark-700 transition-colors"
							>
								<span class="w-4 h-4 rounded-full bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white">
									{MODEL_FAMILY_ICONS[currentModel.family]}
								</span>
								<span class="hidden sm:inline">{currentModel.name.split(' ').pop()}</span>
								<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M19 9l-7 7-7-7"
									/>
								</svg>
							</button>

							{showModelMenu && (
								<div class="absolute right-0 top-full mt-1 w-48 bg-dark-800 border border-dark-700 rounded-lg shadow-lg z-50 py-1">
									{NEO_MODELS.map((model) => (
										<button
											key={model.id}
											onClick={() => {
												setSelectedModel(model.id);
												setShowModelMenu(false);
											}}
											class={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-dark-700 ${
												selectedModel === model.id ? 'text-blue-400' : 'text-gray-300'
											}`}
										>
											<span
												class={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
													model.family === 'opus'
														? 'bg-purple-600'
														: model.family === 'sonnet'
															? 'bg-blue-600'
															: model.family === 'haiku'
																? 'bg-green-600'
																: 'bg-orange-600'
												} text-white`}
											>
												{MODEL_FAMILY_ICONS[model.family]}
											</span>
											<span>{model.name}</span>
											{selectedModel === model.id && (
												<svg class="w-4 h-4 ml-auto" fill="currentColor" viewBox="0 0 20 20">
													<path
														fill-rule="evenodd"
														d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
														clip-rule="evenodd"
													/>
												</svg>
											)}
										</button>
									))}
								</div>
							)}
						</div>

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
					{messages.length === 0 ? (
						<div class="text-center text-gray-400 py-8">
							<p>Start a conversation with Neo</p>
							<p class="text-sm mt-2">
								Ask Neo to create tasks, manage sessions, or help with your work.
							</p>
						</div>
					) : (
						messages.map((msg) => <NeoMessage key={msg.id} message={msg} />)
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
						<span>
							{thinkingMode ? (
								<span class="flex items-center gap-1">
									<span class="w-1.5 h-1.5 rounded-full bg-purple-400" />
									Thinking enabled
								</span>
							) : (
								''
							)}
						</span>
						<span class="flex items-center gap-1">
							{attachments.length > 0 && (
								<span class="text-blue-400">{attachments.length} attachment(s)</span>
							)}
						</span>
					</div>
				</div>
			</div>

			{/* Click outside to close model menu */}
			{showModelMenu && <div class="fixed inset-0 z-40" onClick={() => setShowModelMenu(false)} />}
		</>
	);
}

function NeoMessage({ message }: { message: NeoContextMessage }) {
	const isUser = message.role === 'user';
	const isSystem = message.role === 'system';

	return (
		<div class={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
			<div
				class={`max-w-[80%] rounded-lg px-3 py-2 ${
					isUser
						? 'bg-blue-600 text-white'
						: isSystem
							? 'bg-dark-700 text-gray-300 text-xs'
							: 'bg-dark-800 text-gray-100'
				}`}
			>
				<p class="text-sm whitespace-pre-wrap">{message.content}</p>
				<p class="text-xs opacity-50 mt-1">{new Date(message.timestamp).toLocaleTimeString()}</p>
			</div>
		</div>
	);
}
