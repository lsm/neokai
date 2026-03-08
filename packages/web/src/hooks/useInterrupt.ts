/**
 * useInterrupt Hook
 *
 * Handles agent interrupt functionality.
 * Extracted from MessageInput.tsx for better separation of concerns.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { t } from '../lib/i18n.ts';

export interface UseInterruptOptions {
	sessionId: string;
}

export interface UseInterruptResult {
	interrupting: boolean;
	handleInterrupt: () => Promise<void>;
}

/**
 * Hook for managing agent interruption
 */
export function useInterrupt({ sessionId }: UseInterruptOptions): UseInterruptResult {
	const [interrupting, setInterrupting] = useState(false);

	// Reset interrupting state on session change
	useEffect(() => {
		setInterrupting(false);
	}, [sessionId]);

	const handleInterrupt = useCallback(async () => {
		if (interrupting) return;

		try {
			setInterrupting(true);
			const hub = connectionManager.getHubIfConnected();
			if (!hub) {
				toast.error(t('toast.notConnected'));
				return;
			}
			await hub.request('client.interrupt', { sessionId });
		} catch {
			toast.error(t('toast.stopFailed'));
		} finally {
			setTimeout(() => setInterrupting(false), 500);
		}
	}, [sessionId, interrupting]);

	return {
		interrupting,
		handleInterrupt,
	};
}
