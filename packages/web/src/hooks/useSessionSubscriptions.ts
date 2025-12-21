/**
 * useSessionSubscriptions Hook
 *
 * Manages WebSocket subscriptions for a session.
 * Handles SDK messages, session state, errors, and context compaction events.
 * Extracted from ChatContainer.tsx for better separation of concerns.
 */

import { useEffect, useRef, useCallback } from 'preact/hooks';
import type { Session, ContextInfo } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import { isSDKStreamEvent } from '@liuboer/shared/sdk/type-guards';
import { connectionManager } from '../lib/connection-manager';
import { slashCommandsSignal } from '../lib/signals';
import { toast } from '../lib/toast';
import { getCurrentAction } from '../lib/status-actions';
import type { StructuredError } from '../types/error';

export interface SessionSubscriptionState {
	sending: boolean;
	currentAction: string | undefined;
	streamingPhase: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
	streamingEvents: Extract<SDKMessage, { type: 'stream_event' }>[];
	isCompacting: boolean;
	error: string | null;
	errorDetails: StructuredError | null;
}

export interface SessionSubscriptionCallbacks {
	onSessionUpdate: (session: Session) => void;
	onContextUpdate: (context: ContextInfo) => void;
	onMessageReceived: (message: SDKMessage) => void;
	onErrorDialogOpen: () => void;
}

export interface UseSessionSubscriptionsOptions {
	sessionId: string;
	callbacks: SessionSubscriptionCallbacks;
}

export interface UseSessionSubscriptionsResult {
	state: SessionSubscriptionState;
	resetState: () => void;
}

/**
 * Hook for managing session WebSocket subscriptions
 */
export function useSessionSubscriptions({
	sessionId,
	callbacks,
}: UseSessionSubscriptionsOptions): UseSessionSubscriptionsResult {
	// State refs to avoid stale closures
	const stateRef = useRef<SessionSubscriptionState>({
		sending: false,
		currentAction: undefined,
		streamingPhase: null,
		streamingEvents: [],
		isCompacting: false,
		error: null,
		errorDetails: null,
	});

	// Force update mechanism
	const forceUpdateRef = useRef(0);
	const forceUpdate = useCallback(() => {
		forceUpdateRef.current++;
	}, []);

	// Timeout refs
	const sendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const processingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Seen messages for deduplication
	const seenMessageUuids = useRef<Set<string>>(new Set());

	// State updaters
	const updateState = useCallback(
		(updates: Partial<SessionSubscriptionState>) => {
			stateRef.current = { ...stateRef.current, ...updates };
			forceUpdate();
		},
		[forceUpdate]
	);

	const resetState = useCallback(() => {
		stateRef.current = {
			sending: false,
			currentAction: undefined,
			streamingPhase: null,
			streamingEvents: [],
			isCompacting: false,
			error: null,
			errorDetails: null,
		};
		seenMessageUuids.current.clear();

		if (sendTimeoutRef.current) {
			clearTimeout(sendTimeoutRef.current);
			sendTimeoutRef.current = null;
		}
		if (processingTimeoutRef.current) {
			clearTimeout(processingTimeoutRef.current);
			processingTimeoutRef.current = null;
		}
		forceUpdate();
	}, [forceUpdate]);

	useEffect(() => {
		resetState();

		let isMounted = true;
		const cleanupFunctions: Array<() => void> = [];

		connectionManager
			.getHub()
			.then((hub) => {
				if (!isMounted) return;

				// SDK message subscription
				const unsubSDKMessage = hub.subscribeOptimistic<SDKMessage>(
					'sdk.message',
					(sdkMessage) => {
						// Extract slash commands from init
						if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
							const initMessage = sdkMessage as Record<string, unknown>;
							if (initMessage.slash_commands && Array.isArray(initMessage.slash_commands)) {
								slashCommandsSignal.value = initMessage.slash_commands;
							}
						}

						// Update current action
						const state = stateRef.current;
						const isProcessing =
							state.sending || state.streamingEvents.length > 0 || sdkMessage.type !== 'result';
						const action = getCurrentAction(sdkMessage, isProcessing);
						if (action) {
							updateState({ currentAction: action });
						}

						// Handle stream events
						if (isSDKStreamEvent(sdkMessage)) {
							updateState({
								streamingEvents: [...stateRef.current.streamingEvents, sdkMessage],
							});

							if (processingTimeoutRef.current) {
								clearTimeout(processingTimeoutRef.current);
							}
							processingTimeoutRef.current = setTimeout(
								() => {
									console.warn('[useSessionSubscriptions] Processing timeout');
									updateState({
										sending: false,
										streamingEvents: [],
										currentAction: undefined,
										error: 'Response timed out.',
									});
								},
								5 * 60 * 1000
							);
						} else {
							if (sdkMessage.type === 'result' && sdkMessage.subtype === 'success') {
								updateState({
									streamingEvents: [],
									sending: false,
									currentAction: undefined,
								});
								if (sendTimeoutRef.current) clearTimeout(sendTimeoutRef.current);
								if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
							}

							// Deduplicate and forward message
							if (sdkMessage.uuid) {
								if (!seenMessageUuids.current.has(sdkMessage.uuid)) {
									seenMessageUuids.current.add(sdkMessage.uuid);
								}
							}
							callbacks.onMessageReceived(sdkMessage);
						}
					},
					{ sessionId }
				);
				cleanupFunctions.push(unsubSDKMessage);

				// Compaction subscriptions
				const unsubCompacting = hub.subscribeOptimistic<{ trigger: 'manual' | 'auto' }>(
					'context.compacting',
					() => {
						updateState({
							isCompacting: true,
							currentAction: 'Compacting context...',
						});
						toast.info('Compacting context...');
					},
					{ sessionId }
				);
				cleanupFunctions.push(unsubCompacting);

				const unsubCompacted = hub.subscribeOptimistic<{
					trigger: 'manual' | 'auto';
					preTokens: number;
				}>(
					'context.compacted',
					(data) => {
						updateState({
							isCompacting: false,
							currentAction: undefined,
						});
						const savedTokens = Math.round(data.preTokens * 0.5);
						toast.success(`Context compacted! Freed ~${savedTokens.toLocaleString()} tokens`);
					},
					{ sessionId }
				);
				cleanupFunctions.push(unsubCompacted);

				// Error subscription
				const unsubError = hub.subscribeOptimistic<{
					error: string;
					errorDetails?: StructuredError;
				}>(
					'session.error',
					(data) => {
						updateState({
							error: data.error,
							errorDetails: data.errorDetails || null,
							sending: false,
							streamingEvents: [],
							currentAction: undefined,
						});

						if (data.errorDetails) {
							const isDev = import.meta.env.DEV;
							if (!data.errorDetails.recoverable || isDev) {
								callbacks.onErrorDialogOpen();
							}
						}
						toast.error(data.error);
						if (sendTimeoutRef.current) clearTimeout(sendTimeoutRef.current);
						if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
					},
					{ sessionId }
				);
				cleanupFunctions.push(unsubError);

				// Session state subscription
				const unsubSessionState = hub.subscribeOptimistic<{
					session: Session;
					agent: {
						status: 'idle' | 'queued' | 'processing' | 'interrupted';
						phase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing';
						streamingStartedAt?: number;
					};
					commands: { availableCommands: string[] };
					context: ContextInfo | null;
				}>(
					'state.session',
					(data) => {
						requestAnimationFrame(() => {
							if (data.session) callbacks.onSessionUpdate(data.session);
							if (data.context) callbacks.onContextUpdate(data.context);

							// Update processing state based on agent status
							switch (data.agent.status) {
								case 'idle':
									updateState({
										sending: false,
										currentAction: undefined,
										streamingPhase: null,
										streamingEvents: [],
									});
									break;
								case 'queued':
									updateState({
										sending: true,
										currentAction: 'Queued...',
									});
									if (sendTimeoutRef.current) clearTimeout(sendTimeoutRef.current);
									break;
								case 'processing': {
									const phase = data.agent.phase || 'initializing';
									let action: string;
									switch (phase) {
										case 'initializing':
											action = 'Starting...';
											break;
										case 'thinking':
											action = 'Thinking...';
											break;
										case 'streaming': {
											const duration = data.agent.streamingStartedAt
												? Math.floor((Date.now() - data.agent.streamingStartedAt) / 1000)
												: 0;
											action = duration > 0 ? `Streaming (${duration}s)...` : 'Streaming...';
											break;
										}
										case 'finalizing':
											action = 'Finalizing...';
											break;
									}
									updateState({
										sending: true,
										streamingPhase: phase,
										currentAction: action,
									});
									if (sendTimeoutRef.current) clearTimeout(sendTimeoutRef.current);
									break;
								}
								case 'interrupted':
									updateState({
										sending: false,
										currentAction: 'Interrupted',
										streamingPhase: null,
										streamingEvents: [],
									});
									setTimeout(() => updateState({ currentAction: undefined }), 2000);
									break;
							}

							if (data.commands?.availableCommands) {
								slashCommandsSignal.value = data.commands.availableCommands;
							}
						});
					},
					{ sessionId }
				);
				cleanupFunctions.push(unsubSessionState);
			})
			.catch((err) => {
				console.error('[useSessionSubscriptions] Failed to setup subscriptions:', err);
				updateState({ error: 'Failed to connect to daemon' });
				toast.error('Failed to connect to daemon');
			});

		return () => {
			isMounted = false;
			cleanupFunctions.forEach((cleanup) => cleanup());
			if (sendTimeoutRef.current) clearTimeout(sendTimeoutRef.current);
			if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
		};
	}, [sessionId, callbacks, resetState, updateState]);

	return {
		state: stateRef.current,
		resetState,
	};
}
