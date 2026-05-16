import { useState } from 'preact/hooks';
import { connectionState, authStatus } from '../lib/state.ts';
import { navigateToSession } from '../lib/router.ts';
import { createSession } from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { ConnectionNotReadyError } from '../lib/errors.ts';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';

/**
 * Codex-style landing for `/sessions` when no session is selected: a centered
 * prompt and a starter input. Submitting creates a session, sends the typed
 * text as its first message, and opens the chat.
 */
export function SessionsPage() {
	const [text, setText] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const canCreate =
		connectionState.value === 'connected' && (authStatus.value?.isAuthenticated ?? false);

	const handleSubmit = async () => {
		const content = text.trim();
		if (!content || submitting) return;
		if (!canCreate) {
			toast.error('Not connected to server. Please wait...');
			return;
		}
		setSubmitting(true);
		try {
			const response = await createSession({ workspacePath: undefined });
			if (!response?.sessionId) {
				toast.error('No sessionId in response');
				setSubmitting(false);
				return;
			}
			const hub = connectionManager.getHubIfConnected();
			if (!hub) throw new ConnectionNotReadyError('Not connected to server');
			await hub.request('message.send', { sessionId: response.sessionId, content });
			navigateToSession(response.sessionId);
			// Navigation unmounts this view, so there is no state to reset.
		} catch (err) {
			if (err instanceof ConnectionNotReadyError) {
				toast.error('Connection lost. Please try again.');
			} else {
				toast.error(err instanceof Error ? err.message : 'Failed to start chat');
			}
			setSubmitting(false);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Mobile: open the sidebar drawer */}
			<div class="md:hidden flex items-center px-3 py-2">
				<MobileMenuButton />
			</div>

			{/* Centered landing */}
			<div class="flex-1 flex flex-col items-center justify-center px-6 pb-16">
				<h1 class="text-2xl md:text-3xl font-semibold text-gray-100 mb-8 text-center">
					What should we build?
				</h1>

				<div class="w-full max-w-2xl">
					<div class="bg-dark-800 border border-dark-700 rounded-2xl px-3 py-2.5 transition-colors focus-within:border-dark-600">
						<textarea
							value={text}
							onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
							onKeyDown={handleKeyDown}
							placeholder="Ask anything to start a new chat..."
							rows={3}
							disabled={submitting}
							autoFocus
							class="w-full bg-transparent resize-none px-1.5 py-1 text-sm text-gray-100 placeholder-gray-500 focus:outline-none disabled:opacity-60"
						/>
						<div class="flex items-center justify-end pt-1">
							<button
								type="button"
								data-testid="landing-send"
								onClick={handleSubmit}
								disabled={!text.trim() || submitting || !canCreate}
								title="Start chat"
								aria-label="Start chat"
								class="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
							>
								{submitting ? (
									<svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
										<circle
											class="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											stroke-width="4"
										/>
										<path
											class="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
										/>
									</svg>
								) : (
									<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M12 19V5M5 12l7-7 7 7"
										/>
									</svg>
								)}
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
