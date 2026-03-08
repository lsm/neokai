import { useCallback, useState } from 'preact/hooks';
import { connectionState, authStatus } from '../lib/state.ts';
import { navigateToSession } from '../lib/router.ts';
import { createSession } from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';
import { InputTextarea } from '../components/InputTextarea.tsx';
import { ContentContainer } from '../components/ui/ContentContainer.tsx';
import { ConnectionNotReadyError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';

export function SessionsPage() {
	const [content, setContent] = useState('');
	const [sending, setSending] = useState(false);

	const canCreate =
		connectionState.value === 'connected' && (authStatus.value?.isAuthenticated ?? false);

	const handleSubmit = useCallback(async () => {
		const message = content.trim();
		if (!message || sending) return;

		if (!canCreate) {
			toast.error(t('chat.notConnected'));
			return;
		}

		setSending(true);
		try {
			// Lazy creation: create session + send first message atomically
			const response = await createSession({ workspacePath: undefined });
			if (!response?.sessionId) {
				toast.error(t('toast.noSessionId'));
				return;
			}

			// Send the first message
			const hub = connectionManager.getHubIfConnected();
			if (!hub) {
				throw new ConnectionNotReadyError('Connection lost during session creation');
			}
			await hub.request('message.send', {
				sessionId: response.sessionId,
				content: message,
			});

			setContent('');
			navigateToSession(response.sessionId);
		} catch (err) {
			if (err instanceof ConnectionNotReadyError) {
				toast.error(t('chat.connectionLost'));
			} else {
				toast.error(err instanceof Error ? err.message : t('chat.createFailed'));
			}
		} finally {
			setSending(false);
		}
	}, [content, sending, canCreate]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				if (e.metaKey || e.ctrlKey) {
					e.preventDefault();
					void handleSubmit();
					return;
				}

				const isTouchDevice =
					window.matchMedia('(pointer: coarse)').matches ||
					('ontouchstart' in window && window.innerWidth < 768);

				if (!isTouchDevice && !e.shiftKey) {
					e.preventDefault();
					void handleSubmit();
				}
			}
		},
		[handleSubmit]
	);

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Mobile header */}
			<div class="px-4 py-3 border-b border-dark-700 md:hidden">
				<MobileMenuButton />
			</div>

			{/* Welcome content */}
			<div class="flex-1 flex flex-col items-center justify-center px-6">
				<div class="flex flex-col items-center text-center max-w-md">
					<svg
						class="w-14 h-14 text-gray-600 mb-6"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={1.5}
							d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
						/>
					</svg>
					<h2 class="text-xl font-semibold text-gray-100 mb-2">{t('sessions.welcome.title')}</h2>
					<p class="text-sm text-gray-400">{t('sessions.welcome.desc')}</p>
				</div>
			</div>

			{/* Inline chat input at bottom */}
			<ContentContainer className="pb-4">
				<div class="flex items-end gap-3">
					<InputTextarea
						content={content}
						onContentChange={setContent}
						onKeyDown={handleKeyDown}
						onSubmit={() => {
							void handleSubmit();
						}}
						disabled={!canCreate || sending}
						placeholder={t('input.askOrMake')}
					/>
				</div>
			</ContentContainer>
		</div>
	);
}
