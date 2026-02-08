/**
 * useSendMessage Hook
 *
 * Handles message sending with timeout, validation, and error handling.
 * Extracted from ChatContainer.tsx for better separation of concerns.
 */

import { useRef, useCallback } from 'preact/hooks';
import type { Session, MessageImage } from '@neokai/shared';
import { connectionManager } from '../lib/connection-manager';
import { connectionState } from '../lib/state';
import { toast } from '../lib/toast';

export interface UseSendMessageOptions {
	sessionId: string;
	session: Session | null;
	isSending: boolean;
	onSendStart: () => void;
	onSendComplete: () => void;
	onError: (error: string) => void;
}

export interface UseSendMessageResult {
	sendMessage: (content: string, images?: MessageImage[]) => Promise<void>;
	clearSendTimeout: () => void;
}

const SEND_TIMEOUT_MS = 15000;

/**
 * Hook for sending messages with proper timeout and error handling
 */
export function useSendMessage({
	sessionId,
	session,
	isSending,
	onSendStart,
	onSendComplete,
	onError,
}: UseSendMessageOptions): UseSendMessageResult {
	const sendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearSendTimeout = useCallback(() => {
		if (sendTimeoutRef.current) {
			clearTimeout(sendTimeoutRef.current);
			sendTimeoutRef.current = null;
		}
	}, []);

	const sendMessage = useCallback(
		async (content: string, images?: MessageImage[]) => {
			if (!content.trim() || isSending) return;

			if (session?.status === 'archived') {
				toast.error('Cannot send messages to archived sessions');
				return;
			}

			const isConnected = connectionState.value === 'connected';
			if (!isConnected) {
				toast.error('Connection lost. Please refresh the page.');
				return;
			}

			try {
				onSendStart();

				sendTimeoutRef.current = setTimeout(() => {
					onSendComplete();
					onError('Message send timed out.');
					toast.error('Message send timed out.');
				}, SEND_TIMEOUT_MS);

				const hub = connectionManager.getHubIfConnected();
				if (!hub) {
					toast.error('Connection lost.');
					onSendComplete();
					clearSendTimeout();
					return;
				}

				await hub.query('message.send', { sessionId, content, images });

				// Clear timeout on successful send
				clearSendTimeout();
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Failed to send message';
				onError(message);
				toast.error(message);
				onSendComplete();
				clearSendTimeout();
			}
		},
		[sessionId, session, isSending, onSendStart, onSendComplete, onError, clearSendTimeout]
	);

	return {
		sendMessage,
		clearSendTimeout,
	};
}
