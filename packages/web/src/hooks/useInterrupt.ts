/**
 * useInterrupt Hook
 *
 * Handles agent interrupt functionality with global Escape key support.
 * Extracted from MessageInput.tsx for better separation of concerns.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { isAgentWorking } from '../lib/state.ts';

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
				toast.error('Not connected to server');
				return;
			}
			await hub.call('client.interrupt', { sessionId });
		} catch (error) {
			console.error('Interrupt error:', error);
			toast.error('Failed to stop generation');
		} finally {
			setTimeout(() => setInterrupting(false), 500);
		}
	}, [sessionId, interrupting]);

	// Global Escape key listener for interrupt
	useEffect(() => {
		const handleGlobalEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && isAgentWorking.value && !interrupting) {
				e.preventDefault();
				handleInterrupt();
			}
		};

		document.addEventListener('keydown', handleGlobalEscape);
		return () => document.removeEventListener('keydown', handleGlobalEscape);
	}, [interrupting, handleInterrupt]);

	return {
		interrupting,
		handleInterrupt,
	};
}
