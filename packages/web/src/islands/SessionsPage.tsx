import { useState } from 'preact/hooks';
import { connectionState, authStatus } from '../lib/state.ts';
import { navigateToSession } from '../lib/router.ts';
import { createSession } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import { Button } from '../components/ui/Button.tsx';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';
import { ConnectionNotReadyError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';

export function SessionsPage() {
	const [creating, setCreating] = useState(false);

	const canCreate =
		connectionState.value === 'connected' && (authStatus.value?.isAuthenticated ?? false);

	const handleNewSession = async () => {
		if (!canCreate) {
			toast.error(t('chat.notConnected'));
			return;
		}
		setCreating(true);
		try {
			const response = await createSession({ workspacePath: undefined });
			if (!response?.sessionId) {
				toast.error(t('toast.noSessionId'));
				return;
			}
			navigateToSession(response.sessionId);
			toast.success(t('chat.sessionCreated'));
		} catch (err) {
			if (err instanceof ConnectionNotReadyError) {
				toast.error(t('chat.connectionLost'));
			} else {
				toast.error(err instanceof Error ? err.message : t('chat.createFailed'));
			}
		} finally {
			setCreating(false);
		}
	};

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
					<h2 class="text-xl font-semibold text-gray-100 mb-2">
						{t('sessions.welcome.title')}
					</h2>
					<p class="text-sm text-gray-400 mb-8">{t('sessions.welcome.desc')}</p>
					<Button
						onClick={handleNewSession}
						loading={creating}
						disabled={!canCreate}
						icon={
							<svg
								class="w-4 h-4"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M12 4v16m8-8H4"
								/>
							</svg>
						}
					>
						{t('sessions.newSession')}
					</Button>
				</div>
			</div>
		</div>
	);
}
