/**
 * NeoChatPanel - Collapsible overlay panel for Neo chat
 *
 * A right-side overlay panel for the AI orchestrator chat.
 * Controlled by neoChatOpenSignal.
 */

import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { roomStore } from '../lib/room-store';
import { toast } from '../lib/toast';
import { neoChatOpenSignal } from '../lib/signals';
import { Button } from '../components/ui/Button';
import { IconButton } from '../components/ui/IconButton';
import type { NeoContextMessage } from '@neokai/shared';

export function NeoChatPanel() {
	const [input, setInput] = useState('');
	const [sending, setSending] = useState(false);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const isOpen = neoChatOpenSignal.value;

	// Auto-scroll to bottom on new messages
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [roomStore.neoMessages.value.length]);

	const handleSend = useCallback(async () => {
		if (!input.trim() || sending) return;

		try {
			setSending(true);
			await roomStore.sendNeoMessage(input.trim());
			setInput('');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to send');
		} finally {
			setSending(false);
		}
	}, [input, sending]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				handleSend();
			}
		},
		[handleSend]
	);

	const handleClose = () => {
		neoChatOpenSignal.value = false;
	};

	const messages = roomStore.neoMessages.value;

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
					<div>
						<h3 class="font-semibold text-gray-100">Neo</h3>
						<p class="text-xs text-gray-400">AI Orchestrator</p>
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

				{/* Messages */}
				<div class="flex-1 overflow-y-auto p-4 space-y-4">
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

				{/* Input */}
				<div class="p-4 border-t border-dark-700">
					<div class="flex gap-2">
						<textarea
							value={input}
							onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
							onKeyDown={handleKeyDown}
							placeholder="Ask Neo..."
							disabled={sending}
							class="flex-1 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:border-blue-500"
							rows={2}
						/>
						<Button onClick={handleSend} loading={sending} disabled={!input.trim()} size="sm">
							Send
						</Button>
					</div>
				</div>
			</div>
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
