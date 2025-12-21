/**
 * useMessageLoader Hook
 *
 * Manages loading messages for a session including initial load and pagination.
 * Extracted from ChatContainer.tsx for better separation of concerns.
 */

import type { RefObject } from 'preact';
import { useState, useCallback, useRef } from 'preact/hooks';
import type { Session, ContextInfo, SessionState } from '@liuboer/shared';
import { STATE_CHANNELS } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import { connectionManager } from '../lib/connection-manager';
import { getSession, getSDKMessages, getMessageCount, getSlashCommands } from '../lib/api-helpers';
import { toast } from '../lib/toast';
import { currentSessionIdSignal, slashCommandsSignal } from '../lib/signals';

export interface UseMessageLoaderOptions {
	sessionId: string;
	messagesContainerRef: RefObject<HTMLDivElement>;
}

export interface UseMessageLoaderResult {
	// State
	session: Session | null;
	messages: SDKMessage[];
	loading: boolean;
	loadingOlder: boolean;
	hasMoreMessages: boolean;
	isInitialLoad: boolean;
	error: string | null;
	contextUsage: ContextInfo | undefined;
	autoScroll: boolean;

	// Actions
	loadSession: () => Promise<void>;
	loadOlderMessages: () => Promise<void>;
	setSession: (session: Session) => void;
	setContextUsage: (context: ContextInfo) => void;
	setAutoScroll: (autoScroll: boolean) => void;
	setError: (error: string | null) => void;
	addMessage: (message: SDKMessage) => void;
	updateMessage: (message: SDKMessage) => void;

	// Refs
	seenMessageUuids: React.RefObject<Set<string>>;
}

/**
 * Hook for loading and managing session messages
 */
export function useMessageLoader({
	sessionId,
	messagesContainerRef,
}: UseMessageLoaderOptions): UseMessageLoaderResult {
	const [session, setSession] = useState<Session | null>(null);
	const [messages, setMessages] = useState<SDKMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [hasMoreMessages, setHasMoreMessages] = useState(true);
	const [isInitialLoad, setIsInitialLoad] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [contextUsage, setContextUsage] = useState<ContextInfo | undefined>(undefined);
	const [autoScroll, setAutoScroll] = useState(false);

	const seenMessageUuids = useRef<Set<string>>(new Set());

	const loadSession = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);
			setIsInitialLoad(true);

			const response = await getSession(sessionId);
			setSession(response.session);
			setAutoScroll(response.session.config.autoScroll ?? false);

			const [sdkResponse, countResponse] = await Promise.all([
				getSDKMessages(sessionId, { limit: 100 }),
				getMessageCount(sessionId),
			]);

			const loadedMessages = sdkResponse.sdkMessages as SDKMessage[];
			setMessages(loadedMessages);

			seenMessageUuids.current.clear();
			loadedMessages.forEach((msg) => {
				if (msg.uuid) seenMessageUuids.current.add(msg.uuid);
			});

			setHasMoreMessages(sdkResponse.sdkMessages.length < countResponse.count);

			// Load initial state
			try {
				const hub = connectionManager.getHubIfConnected();
				if (hub) {
					const sessionState = await hub.call<SessionState>(
						STATE_CHANNELS.SESSION,
						{ sessionId },
						{ sessionId: 'global' }
					);
					if (sessionState?.context) setContextUsage(sessionState.context);
					if (sessionState?.commands?.availableCommands?.length > 0) {
						slashCommandsSignal.value = sessionState.commands.availableCommands;
					}
				}
			} catch {
				// Fallback to load commands
				try {
					const commandsResponse = await getSlashCommands(sessionId);
					if (commandsResponse.commands?.length > 0) {
						slashCommandsSignal.value = commandsResponse.commands;
					}
				} catch {
					// Will be loaded from events
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to load session';
			if (message.includes('Session not found') || message.includes('404')) {
				currentSessionIdSignal.value = null;
				toast.error('Session not found.');
				return;
			}
			setError(message);
			toast.error(message);
		} finally {
			setLoading(false);
		}
	}, [sessionId]);

	const loadOlderMessages = useCallback(async () => {
		if (loadingOlder || !hasMoreMessages || messages.length === 0) return;

		try {
			setLoadingOlder(true);

			const container = messagesContainerRef.current;
			const oldScrollHeight = container?.scrollHeight || 0;
			const oldScrollTop = container?.scrollTop || 0;

			const oldestMessage = messages[0] as SDKMessage & { timestamp?: number };
			const beforeTimestamp = oldestMessage?.timestamp;
			if (!beforeTimestamp) {
				setHasMoreMessages(false);
				return;
			}

			const sdkResponse = await getSDKMessages(sessionId, { limit: 100, before: beforeTimestamp });
			if (sdkResponse.sdkMessages.length === 0) {
				setHasMoreMessages(false);
				return;
			}

			const olderMessages = sdkResponse.sdkMessages as SDKMessage[];
			setMessages((prev) => [...olderMessages, ...prev]);
			olderMessages.forEach((msg) => {
				if (msg.uuid) seenMessageUuids.current.add(msg.uuid);
			});

			setHasMoreMessages(sdkResponse.sdkMessages.length === 100);

			requestAnimationFrame(() => {
				if (container) {
					container.scrollTop = oldScrollTop + (container.scrollHeight - oldScrollHeight);
				}
			});
		} catch (err) {
			console.error('Failed to load older messages:', err);
			toast.error('Failed to load older messages');
		} finally {
			setLoadingOlder(false);
		}
	}, [sessionId, loadingOlder, hasMoreMessages, messages, messagesContainerRef]);

	const addMessage = useCallback((message: SDKMessage) => {
		setMessages((prev) => {
			if (message.uuid) {
				if (seenMessageUuids.current.has(message.uuid)) {
					// Update existing message
					return prev.map((m) => (m.uuid === message.uuid ? message : m));
				} else {
					seenMessageUuids.current.add(message.uuid);
					return [...prev, message];
				}
			}
			return [...prev, message];
		});
	}, []);

	const updateMessage = useCallback((message: SDKMessage) => {
		if (!message.uuid) return;
		setMessages((prev) => prev.map((m) => (m.uuid === message.uuid ? message : m)));
	}, []);

	return {
		session,
		messages,
		loading,
		loadingOlder,
		hasMoreMessages,
		isInitialLoad,
		error,
		contextUsage,
		autoScroll,
		loadSession,
		loadOlderMessages,
		setSession,
		setContextUsage,
		setAutoScroll,
		setError,
		addMessage,
		updateMessage,
		seenMessageUuids,
	};
}
