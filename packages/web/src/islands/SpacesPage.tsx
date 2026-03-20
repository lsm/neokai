/**
 * SpacesPage - Standalone spaces view with recent spaces and chat input
 *
 * Minimalist layout: no sidebar, just recent spaces list + message input at bottom.
 */

import { useEffect, useState } from 'preact/hooks';
import { spaceStore } from '../lib/space-store.ts';
import { navigateToSpace } from '../lib/router.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '../components/ui/Button.tsx';

export function SpacesPage() {
	const [message, setMessage] = useState('');
	const [sending, setSending] = useState(false);
	const spaces = spaceStore.spaces.value;

	// Initialize global space list on mount
	useEffect(() => {
		spaceStore.initGlobalList().catch(() => {
			// Error tracked inside initGlobalList
		});
	}, []);

	// For now, just show recent spaces - will be connected to a space agent later
	const recentSpaces = spaces.slice(0, 5);

	const handleSpaceClick = (spaceId: string) => {
		navigateToSpace(spaceId);
	};

	const handleSendMessage = async () => {
		if (!message.trim() || sending) return;
		setSending(true);
		// TODO: Connect to space agent for chat
		// For now, just clear the input
		setMessage('');
		setSending(false);
	};

	return (
		<div class="flex-1 flex flex-col h-full bg-dark-900">
			{/* Recent Spaces */}
			<div class="flex-1 overflow-y-auto p-6">
				<h2 class="text-lg font-semibold text-gray-100 mb-4">Recent Spaces</h2>
				{recentSpaces.length === 0 ? (
					<div class="flex flex-col items-center justify-center p-8 text-center">
						<div class="text-4xl mb-3">🚀</div>
						<p class="text-gray-400 mb-1">No spaces yet</p>
						<p class="text-sm text-gray-500">Create a space to get started</p>
					</div>
				) : (
					<div class="grid gap-3">
						{recentSpaces.map((space) => (
							<button
								key={space.id}
								onClick={() => handleSpaceClick(space.id)}
								class={cn(
									'p-4 rounded-lg border text-left transition-colors',
									'bg-dark-800 border-dark-700 hover:border-dark-600',
									'hover:bg-dark-800/80'
								)}
							>
								<div class="flex items-center gap-3">
									<div class="w-10 h-10 rounded-lg bg-dark-700 flex items-center justify-center text-xl">
										🚀
									</div>
									<div class="flex-1 min-w-0">
										<h3 class="font-medium text-gray-100 truncate">{space.name}</h3>
										{space.description && (
											<p class="text-sm text-gray-400 truncate">{space.description}</p>
										)}
									</div>
								</div>
							</button>
						))}
					</div>
				)}
			</div>

			{/* Message Input */}
			<div class="border-t border-dark-700 p-4">
				<div class="flex gap-3">
					<textarea
						value={message}
						onChange={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								handleSendMessage();
							}
						}}
						placeholder="Message your space agent..."
						class={cn(
							'flex-1 bg-dark-800 border border-dark-700 rounded-lg',
							'px-4 py-3 text-gray-100 placeholder-gray-500',
							'resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/50',
							'min-h-[48px] max-h-[200px]'
						)}
						rows={1}
					/>
					<Button
						onClick={handleSendMessage}
						disabled={!message.trim() || sending}
						loading={sending}
					>
						<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
							/>
						</svg>
					</Button>
				</div>
			</div>
		</div>
	);
}
