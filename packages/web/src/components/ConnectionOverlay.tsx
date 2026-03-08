/**
 * ConnectionOverlay Component
 *
 * Displays a blocking overlay when WebSocket connection is lost or failed.
 * Provides clear messaging and reconnection options to the user.
 *
 * FIX: Only show overlay for 'failed' state (all auto-reconnect attempts exhausted).
 * Previously showed for 'disconnected' and 'error' too, which caused flashing
 * during auto-reconnect cycles when Safari resumes from background.
 *
 * Auto-reconnect state flow:
 * - 'connected' → 'disconnected' → 'reconnecting' → 'connecting' → (success/fail)
 * - On failure: cycles back through 'disconnected' → 'reconnecting' up to 10 times
 * - After 10 attempts: 'failed' state is set permanently until manual reconnect
 *
 * The overlay should only appear when auto-reconnect has given up ('failed'),
 * not during the transient states while auto-reconnect is still trying.
 */

import { connectionState } from '../lib/state.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { Button } from './ui/Button.tsx';
import { useState } from 'preact/hooks';
import { t } from '../lib/i18n';

/**
 * Helper to check if connection state requires overlay
 * FIX: Only 'failed' shows overlay - all auto-reconnect attempts exhausted
 */
function shouldShowOverlay(state: typeof connectionState.value): state is 'failed' {
	// Only show overlay when all auto-reconnect attempts have failed
	// 'disconnected', 'error', 'reconnecting', 'connecting' are transient states
	// during auto-reconnect and should NOT show the blocking overlay
	return state === 'failed';
}

export function ConnectionOverlay() {
	const state = connectionState.value;
	const [reconnecting, setReconnecting] = useState(false);

	// FIX: Only show overlay for 'failed' state
	// This prevents flashing during auto-reconnect cycles when Safari resumes
	if (!shouldShowOverlay(state)) {
		return null;
	}

	const handleReconnect = async () => {
		setReconnecting(true);
		try {
			await connectionManager.reconnect();
		} catch {
			// Reconnect failed - user can try again
		} finally {
			setReconnecting(false);
		}
	};

	const handleRefresh = () => {
		window.location.reload();
	};

	const title = t('connection.failedTitle');
	const description = t('connection.failedDesc');

	return (
		<div class="fixed inset-0 z-[10000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
			<div class="bg-dark-800 border border-dark-600 p-6 rounded-xl text-center max-w-md w-full shadow-2xl animate-slideIn">
				<h2 class="text-xl font-bold text-white mb-2">{title}</h2>
				<p class="text-gray-400 mb-6">{description}</p>

				<div class="flex gap-3 justify-center">
					<Button onClick={handleReconnect} loading={reconnecting} disabled={reconnecting}>
						{reconnecting ? t('connection.reconnectingLabel') : t('connection.reconnect')}
					</Button>
					<Button variant="secondary" onClick={handleRefresh} disabled={reconnecting}>
						{t('connection.refreshPage')}
					</Button>
				</div>

				{/* FIX: Always show hint since we only display for 'failed' state now */}
				<p class="text-xs text-gray-500 mt-4">
					{t('connection.persistHint')}
				</p>
			</div>
		</div>
	);
}
