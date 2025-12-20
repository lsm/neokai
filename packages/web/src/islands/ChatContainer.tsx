import { useEffect, useRef, useState, useMemo } from 'preact/hooks';
import type { Session, ContextInfo, SessionState, MessageImage } from '@liuboer/shared';
import { STATE_CHANNELS } from '@liuboer/shared';
import type { SDKMessage, SDKSystemMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import { isSDKStreamEvent, isSDKCompactBoundary } from '@liuboer/shared/sdk/type-guards';
import { connectionManager } from '../lib/connection-manager.ts';
import {
	getSession,
	getSDKMessages,
	getMessageCount,
	getSlashCommands,
	deleteSession,
	listSessions,
	updateSession,
	archiveSession,
} from '../lib/api-helpers.ts';
import type { ArchiveSessionResponse } from '@liuboer/shared';
import { toast } from '../lib/toast.ts';
import { cn, formatTokens } from '../lib/utils.ts';
import {
	currentSessionIdSignal,
	sessionsSignal,
	sidebarOpenSignal,
	slashCommandsSignal,
} from '../lib/signals.ts';
import { connectionState } from '../lib/state.ts';
import { borderColors } from '../lib/design-tokens.ts';
import MessageInput from '../components/MessageInput.tsx';
import SessionStatusBar from '../components/SessionStatusBar.tsx';
import { Button } from '../components/ui/Button.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { ToolsModal } from '../components/ToolsModal.tsx';
import { Skeleton, SkeletonMessage } from '../components/ui/Skeleton.tsx';
import { SDKMessageRenderer } from '../components/sdk/SDKMessageRenderer.tsx';
import { SDKStreamingAccumulator } from '../components/sdk/SDKStreamingMessage.tsx';
import { getCurrentAction } from '../lib/status-actions.ts';
import { Tooltip } from '../components/ui/Tooltip.tsx';
import { ErrorDialog } from '../components/ErrorDialog.tsx';
import type { StructuredError } from '../types/error.ts';

interface ChatContainerProps {
	sessionId: string;
}

export default function ChatContainer({ sessionId }: ChatContainerProps) {
	const [session, setSession] = useState<Session | null>(null);
	const [messages, setMessages] = useState<SDKMessage[]>([]);
	const [streamingEvents, setStreamingEvents] = useState<
		Extract<SDKMessage, { type: 'stream_event' }>[]
	>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [errorDetails, setErrorDetails] = useState<StructuredError | null>(null);
	const [errorDialogOpen, setErrorDialogOpen] = useState(false);
	const [sending, setSending] = useState(false);
	const [showScrollButton, setShowScrollButton] = useState(false);
	const [deleteModalOpen, setDeleteModalOpen] = useState(false);
	const [toolsModalOpen, setToolsModalOpen] = useState(false);
	const [archiving, setArchiving] = useState(false);
	const [archiveConfirmDialog, setArchiveConfirmDialog] = useState<{
		show: boolean;
		commitStatus?: ArchiveSessionResponse['commitStatus'];
	} | null>(null);
	const [currentAction, setCurrentAction] = useState<string | undefined>(undefined);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [hasMoreMessages, setHasMoreMessages] = useState(true);
	const [isInitialLoad, setIsInitialLoad] = useState(true);
	const [autoScroll, setAutoScroll] = useState(false);

	/**
	 * Streaming phase tracking for fine-grained UI feedback
	 */
	const [streamingPhase, setStreamingPhase] = useState<
		'initializing' | 'thinking' | 'streaming' | 'finalizing' | null
	>(null);

	/**
	 * Context usage from accurate SDK context info
	 */
	const [contextUsage, setContextUsage] = useState<ContextInfo | undefined>(undefined);

	/**
	 * Compaction state - locks input when context is being compacted
	 */
	const [isCompacting, setIsCompacting] = useState(false);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const sendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const processingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevMessageCountRef = useRef<number>(0);
	// PERFORMANCE: Track seen message UUIDs for O(1) deduplication instead of O(n) findIndex
	const seenMessageUuids = useRef<Set<string>>(new Set());

	useEffect(() => {
		// Reset state when switching sessions
		setSending(false);
		setError(null);
		setCurrentAction(undefined);
		setStreamingEvents([]);
		setStreamingPhase(null);
		setIsCompacting(false);

		// Reset seen message UUIDs for new session
		seenMessageUuids.current.clear();

		// Clear any pending timeouts from previous session
		if (sendTimeoutRef.current) {
			clearTimeout(sendTimeoutRef.current);
			sendTimeoutRef.current = null;
		}
		if (processingTimeoutRef.current) {
			clearTimeout(processingTimeoutRef.current);
			processingTimeoutRef.current = null;
		}

		loadSession();

		// Track cleanup functions and whether component is still mounted
		let isMounted = true;
		const cleanupFunctions: Array<() => void> = [];

		// Set up WebSocket subscriptions asynchronously
		// Using subscribeOptimistic for non-blocking subscriptions - handlers are
		// registered locally immediately, server ACKs happen in background
		connectionManager
			.getHub()
			.then((hub) => {
				// Only subscribe if component is still mounted
				if (!isMounted) return;

				// SDK message events - PRIMARY EVENT HANDLER (NON-BLOCKING)
				const unsubSDKMessage = hub.subscribeOptimistic<SDKMessage>(
					'sdk.message',
					(sdkMessage) => {
						// Extract slash commands from SDK init message
						if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
							const initMessage = sdkMessage as Record<string, unknown> as Record<string, unknown>;
							if (initMessage.slash_commands && Array.isArray(initMessage.slash_commands)) {
								slashCommandsSignal.value = initMessage.slash_commands;
							}
						}

						// Update current action based on this message
						const isProcessing =
							sending || streamingEvents.length > 0 || sdkMessage.type !== 'result';
						const action = getCurrentAction(sdkMessage, isProcessing);
						if (action) {
							setCurrentAction(action);
						}

						// Handle stream events separately for real-time display
						if (isSDKStreamEvent(sdkMessage)) {
							setStreamingEvents((prev) => [...prev, sdkMessage]);

							// Reset processing timeout when we receive streaming events
							if (processingTimeoutRef.current) {
								clearTimeout(processingTimeoutRef.current);
							}
							processingTimeoutRef.current = setTimeout(
								() => {
									console.warn('[ChatContainer] Processing timeout - clearing stuck state');
									setSending(false);
									setStreamingEvents([]);
									setCurrentAction(undefined);
									setError('Response timed out. The connection may have been interrupted.');
								},
								5 * 60 * 1000
							);
						} else {
							// Only clear processing state when we get the FINAL result message
							if (sdkMessage.type === 'result' && sdkMessage.subtype === 'success') {
								setStreamingEvents([]);
								setSending(false);
								setCurrentAction(undefined);
								if (sendTimeoutRef.current) {
									clearTimeout(sendTimeoutRef.current);
									sendTimeoutRef.current = null;
								}
								if (processingTimeoutRef.current) {
									clearTimeout(processingTimeoutRef.current);
									processingTimeoutRef.current = null;
								}
							}
							// Add non-stream messages to main array, deduplicating by uuid
							// PERFORMANCE: Use Set for O(1) UUID lookup instead of O(n) findIndex
							setMessages((prev) => {
								if (sdkMessage.uuid) {
									if (seenMessageUuids.current.has(sdkMessage.uuid)) {
										// Update existing message
										const updated = prev.map((m) => (m.uuid === sdkMessage.uuid ? sdkMessage : m));
										return updated;
									} else {
										// New message - add to set and append
										seenMessageUuids.current.add(sdkMessage.uuid);
										return [...prev, sdkMessage];
									}
								}
								// No UUID - just append (shouldn't happen normally)
								return [...prev, sdkMessage];
							});
						}
					},
					{ sessionId }
				);
				cleanupFunctions.push(unsubSDKMessage);

				// Context is now part of unified session state (no separate subscription needed)

				// Subscribe to compaction start - lock input and show toast (NON-BLOCKING)
				const unsubContextCompacting = hub.subscribeOptimistic<{ trigger: 'manual' | 'auto' }>(
					'context.compacting',
					(_data) => {
						setIsCompacting(true);
						setCurrentAction('Compacting context...');
						toast.info('Compacting context...');
					},
					{ sessionId }
				);
				cleanupFunctions.push(unsubContextCompacting);

				// Subscribe to compaction complete - unlock input and show result (NON-BLOCKING)
				const unsubContextCompacted = hub.subscribeOptimistic<{
					trigger: 'manual' | 'auto';
					preTokens: number;
				}>(
					'context.compacted',
					(data) => {
						setIsCompacting(false);
						setCurrentAction(undefined);
						const savedTokens = Math.round(data.preTokens * 0.5); // Estimate ~50% reduction
						toast.success(`Context compacted! Freed ~${savedTokens.toLocaleString()} tokens`);
					},
					{ sessionId }
				);
				cleanupFunctions.push(unsubContextCompacted);

				// Error handling (NON-BLOCKING)
				const unsubSessionError = hub.subscribeOptimistic<{
					error: string;
					errorDetails?: StructuredError;
				}>(
					'session.error',
					(data) => {
						const { error, errorDetails } = data;
						setError(error);

						// Store rich error details if available
						if (errorDetails) {
							setErrorDetails(errorDetails);
							// Auto-open error dialog for non-recoverable errors or in dev mode
							const isDev = import.meta.env.DEV;
							if (!errorDetails.recoverable || isDev) {
								setErrorDialogOpen(true);
							}
						}

						// Show toast notification with details button
						toast.error(error);

						setSending(false);
						setStreamingEvents([]);
						setCurrentAction(undefined);
						if (sendTimeoutRef.current) {
							clearTimeout(sendTimeoutRef.current);
							sendTimeoutRef.current = null;
						}
						if (processingTimeoutRef.current) {
							clearTimeout(processingTimeoutRef.current);
							processingTimeoutRef.current = null;
						}
					},
					{ sessionId }
				);
				cleanupFunctions.push(unsubSessionError);

				// Subscribe to unified session state - includes agent state, commands, and context (NON-BLOCKING)
				const unsubSessionState = hub.subscribeOptimistic<{
					session: Session;
					agent: {
						status: 'idle' | 'queued' | 'processing' | 'interrupted';
						messageId?: string;
						phase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing';
						streamingStartedAt?: number;
					};
					commands: { availableCommands: string[] };
					context: ContextInfo | null;
				}>(
					'state.session',
					(data) => {
						// Update session metadata (including title)
						if (data.session) {
							setSession(data.session);
						}

						// Update commands
						if (data.commands?.availableCommands) {
							slashCommandsSignal.value = data.commands.availableCommands;
						}

						// Update context info
						if (data.context) {
							setContextUsage(data.context);
						}

						// Update UI based on agent state
						switch (data.agent.status) {
							case 'idle':
								setSending(false);
								setStreamingEvents([]);
								setCurrentAction(undefined);
								setStreamingPhase(null);
								break;
							case 'queued':
								setSending(true);
								setCurrentAction('Queued...');
								setStreamingPhase(null);
								// Clear send timeout when message is successfully queued
								if (sendTimeoutRef.current) {
									clearTimeout(sendTimeoutRef.current);
									sendTimeoutRef.current = null;
								}
								break;
							case 'processing':
								setSending(true);

								// Phase-specific UI feedback
								const phase = data.agent.phase || 'initializing';
								setStreamingPhase(phase);

								switch (phase) {
									case 'initializing':
										setCurrentAction('Starting...');
										break;
									case 'thinking':
										setCurrentAction('Thinking...');
										break;
									case 'streaming':
										// Calculate streaming duration
										const duration = data.agent.streamingStartedAt
											? Math.floor((Date.now() - data.agent.streamingStartedAt) / 1000)
											: 0;
										setCurrentAction(duration > 0 ? `Streaming (${duration}s)...` : 'Streaming...');
										break;
									case 'finalizing':
										setCurrentAction('Finalizing...');
										break;
								}

								// Clear send timeout when processing starts
								if (sendTimeoutRef.current) {
									clearTimeout(sendTimeoutRef.current);
									sendTimeoutRef.current = null;
								}
								break;
							case 'interrupted':
								setSending(false);
								setStreamingEvents([]);
								setCurrentAction('Interrupted');
								setStreamingPhase(null);
								// Clear interrupted status after brief delay
								setTimeout(() => setCurrentAction(undefined), 2000);
								break;
						}
					},
					{ sessionId }
				);
				cleanupFunctions.push(unsubSessionState);
			})
			.catch((error) => {
				console.error('[ChatContainer] Failed to set up subscriptions:', error);
				setError('Failed to connect to daemon');
				toast.error('Failed to connect to daemon');
			});

		// Cleanup function
		return () => {
			isMounted = false;

			// Unsubscribe from all event handlers
			cleanupFunctions.forEach((cleanup) => {
				if (typeof cleanup === 'function') {
					cleanup();
				} else {
					console.warn('[ChatContainer] Cleanup function is not a function:', cleanup);
				}
			});

			// Clean up any pending timeouts
			if (sendTimeoutRef.current) {
				clearTimeout(sendTimeoutRef.current);
				sendTimeoutRef.current = null;
			}
			if (processingTimeoutRef.current) {
				clearTimeout(processingTimeoutRef.current);
				processingTimeoutRef.current = null;
			}
		};
	}, [sessionId]);

	useEffect(() => {
		// Auto-scroll behavior:
		// - Always scroll on initial load to show latest messages (regardless of autoScroll setting)
		// - Only scroll when message count increases (new message) or streaming events change
		// - Never scroll when loading older messages (loadingOlder prevents unwanted scroll)
		const currentCount = messages.length + streamingEvents.length;
		const hasNewContent = currentCount > prevMessageCountRef.current;

		// Always scroll to bottom on initial load when first messages are loaded
		if (isInitialLoad && messages.length > 0) {
			scrollToBottom();
			prevMessageCountRef.current = currentCount;
			// Clear flag after first scroll to prevent subsequent scrolls
			setIsInitialLoad(false);
		}
		// Only scroll for new messages if autoScroll is enabled
		else if (autoScroll && !loadingOlder && hasNewContent) {
			scrollToBottom();
			prevMessageCountRef.current = currentCount;
		}
	}, [messages, streamingEvents, isInitialLoad, loadingOlder, autoScroll]);

	// Detect scroll position to show/hide scroll button
	useEffect(() => {
		const container = messagesContainerRef.current;
		if (!container) return;

		const handleScroll = () => {
			const { scrollTop, scrollHeight, clientHeight } = container;
			const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;
			setShowScrollButton(!isNearBottom);
		};

		// Use requestAnimationFrame to ensure DOM layout is complete before checking scroll position
		// This prevents race conditions where scrollHeight is stale
		const rafId = requestAnimationFrame(handleScroll);

		container.addEventListener('scroll', handleScroll);
		return () => {
			cancelAnimationFrame(rafId);
			container.removeEventListener('scroll', handleScroll);
		};
	}, [messages, streamingEvents]); // Re-run when messages change to update button visibility

	const loadSession = async () => {
		try {
			setLoading(true);
			setError(null);
			setIsInitialLoad(true);
			const response = await getSession(sessionId);
			setSession(response.session);

			// Load auto-scroll setting from session config (defaults to false)
			setAutoScroll(response.session.config.autoScroll ?? false);

			// Load most recent 100 SDK messages and get total count
			const [sdkResponse, countResponse] = await Promise.all([
				getSDKMessages(sessionId, { limit: 100 }),
				getMessageCount(sessionId),
			]);
			const loadedMessages = sdkResponse.sdkMessages as SDKMessage[];
			setMessages(loadedMessages);

			// PERFORMANCE: Initialize seen UUIDs set from loaded messages
			seenMessageUuids.current.clear();
			loadedMessages.forEach((msg) => {
				if (msg.uuid) {
					seenMessageUuids.current.add(msg.uuid);
				}
			});

			// Use actual count to determine if there are more messages
			setHasMoreMessages(sdkResponse.sdkMessages.length < countResponse.count);

			// Load initial session state (includes context info and commands)
			try {
				const hub = connectionManager.getHubIfConnected();
				if (!hub) {
					// Not connected, will populate from events later
					return;
				}

				// Fetch state.session snapshot to get initial context info
				// This includes: session, agent state, commands, and context info
				const sessionState = await hub.call<SessionState>(
					STATE_CHANNELS.SESSION,
					{ sessionId },
					{ sessionId: 'global' } // RPC handlers are registered globally
				);

				// Set context info from snapshot (may be null for new sessions)
				if (sessionState?.context) {
					setContextUsage(sessionState.context);
				}

				// Set slash commands from snapshot
				if (sessionState?.commands?.availableCommands?.length > 0) {
					slashCommandsSignal.value = sessionState.commands.availableCommands;
				}
			} catch (stateError) {
				// State might not be available yet - will be populated from events
				console.log('Initial state not yet available:', stateError);

				// Fallback: try to load slash commands separately
				try {
					const commandsResponse = await getSlashCommands(sessionId);
					if (commandsResponse.commands && commandsResponse.commands.length > 0) {
						slashCommandsSignal.value = commandsResponse.commands;
					}
				} catch {
					// Slash commands not yet available, will be loaded from events
				}
			}

			// Note: isInitialLoad will be cleared by the auto-scroll effect after first scroll
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to load session';

			// Check if this is a session not found error
			// If so, clear the session ID to navigate back to the default page
			if (message.includes('Session not found') || message.includes('404')) {
				console.log('Session not found, clearing session ID and returning to home');
				currentSessionIdSignal.value = null;
				toast.error('Session not found. Returning to sessions list.');
				return; // Don't set error state, just clear and return
			}

			setError(message);
			toast.error(message);
		} finally {
			setLoading(false);
		}
	};

	const loadOlderMessages = async () => {
		if (loadingOlder || !hasMoreMessages || messages.length === 0) return;

		try {
			setLoadingOlder(true);

			// Save current scroll position to restore after loading
			const container = messagesContainerRef.current;
			const oldScrollHeight = container?.scrollHeight || 0;
			const oldScrollTop = container?.scrollTop || 0;

			// Get the oldest message's timestamp as cursor
			const oldestMessage = messages[0] as SDKMessage & { timestamp?: number };
			const beforeTimestamp = oldestMessage?.timestamp;

			if (!beforeTimestamp) {
				console.warn('No timestamp on oldest message, cannot load older messages');
				setHasMoreMessages(false);
				return;
			}

			// Load messages older than the current oldest
			const sdkResponse = await getSDKMessages(sessionId, {
				limit: 100,
				before: beforeTimestamp,
			});

			if (sdkResponse.sdkMessages.length === 0) {
				setHasMoreMessages(false);
				return;
			}

			// Prepend older messages to the beginning of the array
			const olderMessages = sdkResponse.sdkMessages as SDKMessage[];
			setMessages((prev) => [...olderMessages, ...prev]);

			// PERFORMANCE: Add older message UUIDs to seen set
			olderMessages.forEach((msg) => {
				if (msg.uuid) {
					seenMessageUuids.current.add(msg.uuid);
				}
			});

			// Update message count ref to prevent autoscroll from triggering
			prevMessageCountRef.current =
				messages.length + sdkResponse.sdkMessages.length + streamingEvents.length;

			// Check if there are more messages
			setHasMoreMessages(sdkResponse.sdkMessages.length === 100);

			// Restore scroll position after new messages are rendered
			// Use requestAnimationFrame to ensure DOM has updated
			requestAnimationFrame(() => {
				if (container) {
					const newScrollHeight = container.scrollHeight;
					const scrollDiff = newScrollHeight - oldScrollHeight;
					container.scrollTop = oldScrollTop + scrollDiff;
				}
			});
		} catch (err) {
			console.error('Failed to load older messages:', err);
			toast.error('Failed to load older messages');
		} finally {
			setLoadingOlder(false);
		}
	};

	const handleSendMessage = async (content: string, images?: MessageImage[]) => {
		if (!content.trim() || sending) return;

		// Prevent sending to archived sessions
		if (session?.status === 'archived') {
			toast.error('Cannot send messages to archived sessions');
			return;
		}

		// Check if MessageHub is connected
		if (connectionState.value !== 'connected') {
			toast.error('Connection lost. Please refresh the page.');
			return;
		}

		try {
			setSending(true);
			setError(null);
			setCurrentAction('Sending...');

			// Set a timeout to prevent getting stuck in "sending" state
			// If we don't get any response in 15 seconds, clear the sending state
			// This timeout should only fire if the RPC call hangs or the state event never arrives
			sendTimeoutRef.current = setTimeout(() => {
				console.warn('Send timeout - no response from server');
				setSending(false);
				setCurrentAction(undefined);
				setError('Message send timed out. Please try again.');
				toast.error('Message send timed out. Please try again.');
			}, 15000);

			// Send via MessageHub RPC (streaming input mode!)
			// The daemon will queue the message and yield it to the SDK AsyncGenerator
			const hub = connectionManager.getHubIfConnected();
			if (!hub) {
				toast.error('Connection lost. Please refresh the page.');
				setSending(false);
				setCurrentAction(undefined);
				return;
			}
			await hub.call('message.send', {
				sessionId,
				content,
				images,
			});

			// Note: Don't set sending=false here - wait for agent.state event
			// The timeout above will handle the case where we never get a response
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to send message';
			setError(message);
			toast.error(message);
			setSending(false);
			setCurrentAction(undefined);

			// Clear the timeout since we're handling the error
			if (sendTimeoutRef.current) {
				clearTimeout(sendTimeoutRef.current);
				sendTimeoutRef.current = null;
			}
		}
	};

	const scrollToBottom = () => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	};

	const handleDeleteSession = async () => {
		try {
			// Close modal immediately to give user feedback
			setDeleteModalOpen(false);

			await deleteSession(sessionId);

			// Reload sessions to get the updated list from API
			const response = await listSessions();
			sessionsSignal.value = response.sessions;

			// Navigate to home page - use setTimeout to ensure state updates propagate
			// This gives the component tree a chance to process the session deletion
			setTimeout(() => {
				currentSessionIdSignal.value = null;
			}, 0);

			toast.success('Session deleted');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to delete session');
		}
	};

	const handleMenuClick = () => {
		sidebarOpenSignal.value = true;
	};

	const handleAutoScrollChange = async (newAutoScroll: boolean) => {
		// Update local state immediately for responsive UI
		setAutoScroll(newAutoScroll);

		// Persist to database
		try {
			await updateSession(sessionId, { config: { autoScroll: newAutoScroll } });
		} catch (err) {
			// Revert on error
			setAutoScroll(!newAutoScroll);
			toast.error('Failed to save auto-scroll setting');
			console.error('Failed to update autoScroll:', err);
		}
	};

	const handleArchiveClick = async () => {
		try {
			setArchiving(true);
			const result = await archiveSession(sessionId, false);

			if (result.requiresConfirmation && result.commitStatus) {
				setArchiveConfirmDialog({ show: true, commitStatus: result.commitStatus });
			} else if (result.success) {
				toast.success('Session archived successfully');
				// Reload sessions list
				const response = await listSessions();
				sessionsSignal.value = response.sessions;
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to archive session');
		} finally {
			setArchiving(false);
		}
	};

	const handleConfirmArchive = async () => {
		try {
			setArchiving(true);
			const result = await archiveSession(sessionId, true);

			if (result.success) {
				toast.success(`Session archived (${result.commitsRemoved} commits removed)`);
				setArchiveConfirmDialog(null);
				// Reload sessions list
				const response = await listSessions();
				sessionsSignal.value = response.sessions;
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to archive session');
		} finally {
			setArchiving(false);
		}
	};

	// Check if connected for guarding RPC operations
	const isConnected = connectionState.value === 'connected';

	const getHeaderActions = () => [
		{
			label: 'Tools',
			onClick: () => setToolsModalOpen(true),
			icon: (
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
					/>
				</svg>
			),
		},
		{
			label: 'Export Chat',
			onClick: async () => {
				// Guard: Check connection before RPC call
				if (!isConnected) {
					toast.error('Not connected to server');
					return;
				}
				try {
					const hub = connectionManager.getHubIfConnected();
					if (!hub) {
						toast.error('Not connected to server');
						return;
					}
					const result = await hub.call<{ markdown: string }>('session.export', {
						sessionId,
						format: 'markdown',
					});
					// Download as file
					const blob = new Blob([result.markdown], { type: 'text/markdown' });
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = `${session?.title || 'chat'}-export.md`;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
					URL.revokeObjectURL(url);
					toast.success('Chat exported!');
				} catch (err) {
					console.error('Failed to export chat:', err);
					toast.error('Failed to export chat');
				}
			},
			disabled: !isConnected,
			icon: (
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
					/>
				</svg>
			),
		},
		{ type: 'divider' as const },
		{
			label: 'Archive Session',
			onClick: handleArchiveClick,
			disabled: archiving || session?.status === 'archived' || !isConnected,
			icon: (
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
					/>
				</svg>
			),
		},
		{
			label: 'Delete Chat',
			onClick: () => setDeleteModalOpen(true),
			danger: true,
			disabled: !isConnected,
			icon: (
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
					/>
				</svg>
			),
		},
	];

	if (loading) {
		return (
			<div class="flex-1 flex flex-col bg-dark-900">
				{/* Header Skeleton */}
				<div class={`bg-dark-850/50 backdrop-blur-sm border-b ${borderColors.ui.default} p-4`}>
					<Skeleton width="200px" height={24} class="mb-2" />
					<Skeleton width="150px" height={16} />
				</div>

				{/* Messages Skeleton */}
				<div class="flex-1 overflow-y-auto">
					{Array.from({ length: 3 }).map((_, i) => (
						<SkeletonMessage key={i} />
					))}
				</div>
			</div>
		);
	}

	if (error && !session) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<div class="text-5xl mb-4">⚠️</div>
					<h3 class="text-lg font-semibold text-gray-100 mb-2">Failed to load session</h3>
					<p class="text-sm text-gray-400 mb-4">{error}</p>
					<Button onClick={loadSession}>Retry</Button>
				</div>
			</div>
		);
	}

	// Calculate accumulated stats from result messages (fallback if metadata not available)
	// Session metadata is the source of truth for accurate counts across pagination
	const accumulatedStats = messages.reduce(
		(acc, msg) => {
			if (msg.type === 'result' && msg.subtype === 'success') {
				acc.inputTokens += msg.usage.input_tokens;
				acc.outputTokens += msg.usage.output_tokens;
				acc.totalCost += msg.total_cost_usd;
			}
			return acc;
		},
		{ inputTokens: 0, outputTokens: 0, totalCost: 0 }
	);

	// Use session metadata for all stats if available (more accurate than loaded messages)
	// This ensures counts are correct even when messages are paginated
	const displayStats = {
		inputTokens: session?.metadata?.inputTokens ?? accumulatedStats.inputTokens,
		outputTokens: session?.metadata?.outputTokens ?? accumulatedStats.outputTokens,
		totalTokens:
			session?.metadata?.totalTokens ??
			accumulatedStats.inputTokens + accumulatedStats.outputTokens,
		totalCost: session?.metadata?.totalCost ?? accumulatedStats.totalCost,
	};

	// Create a map of tool use IDs to tool results for easy lookup
	// Enhanced to include message UUID, session ID, and removed status for deletion functionality
	// PERFORMANCE: Memoized to avoid O(n*m) recalculation on every render
	const removedOutputs = session?.metadata?.removedOutputs || [];
	const toolResultsMap = useMemo(() => {
		const map = new Map<string, unknown>();
		messages.forEach((msg) => {
			if (msg.type === 'user' && Array.isArray(msg.message.content)) {
				msg.message.content.forEach((block: unknown) => {
					const blockObj = block as Record<string, unknown>;
					if (blockObj.type === 'tool_result' && blockObj.tool_use_id) {
						const toolUseId = blockObj.tool_use_id as string;
						const isRemoved = msg.uuid ? removedOutputs.includes(msg.uuid) : false;
						const resultData = {
							content: block,
							messageUuid: msg.uuid,
							sessionId,
							isOutputRemoved: isRemoved,
						};
						map.set(toolUseId, resultData);
					}
				});
			}
		});
		return map;
	}, [messages, removedOutputs, sessionId]);

	// Create a map of tool use IDs to tool inputs for easy lookup
	// PERFORMANCE: Memoized to avoid O(n*m) recalculation on every render
	const toolInputsMap = useMemo(() => {
		const map = new Map<string, unknown>();
		messages.forEach((msg) => {
			if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
				msg.message.content.forEach((block: unknown) => {
					const blockObj = block as Record<string, unknown>;
					if (blockObj.type === 'tool_use' && blockObj.id) {
						map.set(blockObj.id as string, blockObj.input);
					}
				});
			}
		});
		return map;
	}, [messages]);

	// Create a map of user message UUIDs to their attached session init info
	// Session init messages appear after the first user message, so we attach them to the preceding user message
	// PERFORMANCE: Memoized to avoid O(n²) recalculation on every render
	const sessionInfoMap = useMemo(() => {
		const map = new Map<string, unknown>();
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.type === 'system' && msg.subtype === 'init') {
				// Find the most recent user message before this session init
				for (let j = i - 1; j >= 0; j--) {
					if (messages[j].type === 'user' && messages[j].uuid) {
						map.set(messages[j].uuid!, msg);
						break;
					}
				}
				// If no preceding user message, attach to the first user message after this session init
				if (msg.uuid && !map.has(msg.uuid)) {
					for (let j = i + 1; j < messages.length; j++) {
						if (messages[j].type === 'user' && messages[j].uuid) {
							map.set(messages[j].uuid!, msg);
							break;
						}
					}
				}
			}
		}
		return map;
	}, [messages]);

	// Helper to extract text from a user message
	const extractUserMessageText = (msg: SDKMessage): string => {
		if (msg.type !== 'user') return '';
		const apiMessage = (msg as { message: { content: unknown } }).message;
		if (Array.isArray(apiMessage.content)) {
			return apiMessage.content
				.map((block: unknown) => {
					const b = block as Record<string, unknown>;
					if (b.type === 'text') return b.text as string;
					return '';
				})
				.filter(Boolean)
				.join('\n');
		} else if (typeof apiMessage.content === 'string') {
			return apiMessage.content;
		}
		return '';
	};

	// Create a map of compact boundary UUIDs to their associated synthetic content
	// Synthetic messages appear right after compact boundaries
	// PERFORMANCE: Memoized to avoid O(n²) recalculation on every render
	const { compactSyntheticMap, skipSyntheticSet } = useMemo(() => {
		const map = new Map<string, string>();
		const skipSet = new Set<string>();

		// Helper to check if a message is synthetic
		const isSyntheticMessage = (msg: SDKMessage): boolean => {
			if (msg.type !== 'user') return false;
			const msgWithSynthetic = msg as SDKMessage & { isSynthetic?: boolean };
			// Check isSynthetic flag - all SDK-emitted user messages are marked synthetic by daemon
			if (msgWithSynthetic.isSynthetic) return true;
			// Backward compatibility: check content pattern for legacy messages without flag
			const text = extractUserMessageText(msg);
			return text.startsWith('This session is being continued from a previous conversation');
		};

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			// Use proper type guard for compact boundary detection
			if (isSDKCompactBoundary(msg) && msg.uuid) {
				// Look for the next synthetic user message
				for (let j = i + 1; j < messages.length; j++) {
					const nextMsg = messages[j];
					if (isSyntheticMessage(nextMsg)) {
						const text = extractUserMessageText(nextMsg);
						if (text) {
							map.set(msg.uuid, text);
							if (nextMsg.uuid) {
								skipSet.add(nextMsg.uuid);
							}
						}
						break;
					}
					// Stop searching if we hit a non-user message that's not system
					if (nextMsg.type !== 'user' && nextMsg.type !== 'system') {
						break;
					}
				}
			}
		}

		return { compactSyntheticMap: map, skipSyntheticSet: skipSet };
	}, [messages]);

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-x-hidden relative">
			{/* Header */}
			<div
				class={`bg-dark-850/50 backdrop-blur-sm border-b ${borderColors.ui.default} p-4 relative z-10`}
			>
				<div class="max-w-4xl mx-auto w-full px-4 md:px-0 flex items-center gap-3">
					{/* Hamburger menu button - visible only on mobile */}
					<button
						onClick={handleMenuClick}
						class={`md:hidden p-2 -ml-2 bg-dark-850 border ${borderColors.ui.default} rounded-lg hover:bg-dark-800 transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0`}
						title="Open menu"
					>
						<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M4 6h16M4 12h16M4 18h16"
							/>
						</svg>
					</button>

					{/* Session title and stats */}
					<div class="flex-1 min-w-0">
						<h2 class="text-lg font-semibold text-gray-100 truncate">
							{session?.title || 'New Session'}
						</h2>
						<div class="flex items-center gap-3 mt-1 text-xs text-gray-400">
							<span class="flex items-center gap-1" title="Total tokens">
								<svg class="w-3 h-3" fill="currentColor" viewBox="-1 -1 18 18">
									<path d="M8 2a.5.5 0 0 1 .5.5V4a.5.5 0 0 1-1 0V2.5A.5.5 0 0 1 8 2M3.732 3.732a.5.5 0 0 1 .707 0l.915.914a.5.5 0 1 1-.708.708l-.914-.915a.5.5 0 0 1 0-.707M2 8a.5.5 0 0 1 .5-.5h1.586a.5.5 0 0 1 0 1H2.5A.5.5 0 0 1 2 8m9.5 0a.5.5 0 0 1 .5-.5h1.5a.5.5 0 0 1 0 1H12a.5.5 0 0 1-.5-.5m.754-4.246a.39.39 0 0 0-.527-.02L7.547 7.31A.91.91 0 1 0 8.85 8.569l3.434-4.297a.39.39 0 0 0-.029-.518z" />
									<path
										fill-rule="evenodd"
										d="M6.664 15.889A8 8 0 1 1 9.336.11a8 8 0 0 1-2.672 15.78zm-4.665-4.283A11.95 11.95 0 0 1 8 10c2.186 0 4.236.585 6.001 1.606a7 7 0 1 0-12.002 0"
									/>
								</svg>
								{formatTokens(displayStats.totalTokens)}
							</span>
							<span class="text-gray-500">•</span>
							<span class="font-mono text-green-400">${displayStats.totalCost.toFixed(4)}</span>
						</div>
						{/* Git branch info */}
						{(session?.worktree?.branch || session?.gitBranch) && (
							<div class="flex items-center gap-1.5 mt-1 text-xs text-gray-500">
								<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
									/>
								</svg>
								<span class="font-mono">{session?.worktree?.branch || session?.gitBranch}</span>
								{session?.worktree && (
									<Tooltip content="Using isolated git worktree" position="bottom">
										<svg
											class="w-3.5 h-3.5 text-purple-400"
											viewBox="0 0 16 16"
											fill="currentColor"
											xmlns="http://www.w3.org/2000/svg"
										>
											<path
												fill-rule="evenodd"
												d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM9.25 3.25a2.75 2.75 0 1 1 3.5 2.646v1.54A2.76 2.76 0 0 1 10 10.25h-.75v2.354a2.75 2.75 0 1 1-1.5 0V10.25H7A2.76 2.76 0 0 1 4.25 7.5V5.896a2.75 2.75 0 1 1 1.5 0V7.5A1.26 1.26 0 0 0 7 8.75h3a1.26 1.26 0 0 0 1.25-1.25V5.896a2.75 2.75 0 0 1-2-2.646ZM5 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm3.25 11.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"
												clip-rule="evenodd"
											/>
										</svg>
									</Tooltip>
								)}
							</div>
						)}
					</div>

					{/* Options dropdown */}
					<Dropdown
						trigger={
							<IconButton
								title={connectionState.value !== 'connected' ? 'Not connected' : 'Session options'}
								disabled={connectionState.value !== 'connected'}
							>
								<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
									<path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
								</svg>
							</IconButton>
						}
						items={getHeaderActions()}
					/>
				</div>
			</div>

			{/* Messages - wrapper with relative positioning for the scroll button */}
			<div class="flex-1 relative">
				<div
					ref={messagesContainerRef}
					data-messages-container
					class="absolute inset-0 overflow-y-auto"
				>
					{messages.length === 0 && streamingEvents.length === 0 ? (
						<div class="flex items-center justify-center h-full px-6">
							<div class="text-center">
								<div class="text-5xl mb-4">💬</div>
								<p class="text-lg text-gray-300 mb-2">No messages yet</p>
								<p class="text-sm text-gray-500">
									Start a conversation with Claude to see the magic happen
								</p>
							</div>
						</div>
					) : (
						<div class="max-w-4xl mx-auto w-full px-4 md:px-6 space-y-0">
							{/* Load More Messages Button */}
							{hasMoreMessages && messages.length > 0 && (
								<div class="flex items-center justify-center py-4">
									<Button
										variant="secondary"
										size="sm"
										onClick={loadOlderMessages}
										disabled={loadingOlder}
									>
										{loadingOlder ? (
											<>
												<svg class="animate-spin h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24">
													<circle
														class="opacity-25"
														cx="12"
														cy="12"
														r="10"
														stroke="currentColor"
														stroke-width="4"
													></circle>
													<path
														class="opacity-75"
														fill="currentColor"
														d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
													></path>
												</svg>
												Loading...
											</>
										) : (
											'Load More Messages'
										)}
									</Button>
								</div>
							)}

							{/* Show "No more messages" indicator */}
							{!hasMoreMessages && messages.length > 0 && (
								<div class="flex items-center justify-center py-4">
									<div class="text-xs text-gray-500">Beginning of conversation</div>
								</div>
							)}

							{/* Render all messages using SDK components */}
							{messages.map((msg, idx) => (
								<SDKMessageRenderer
									key={msg.uuid || `msg-${idx}`}
									message={msg}
									toolResultsMap={toolResultsMap}
									toolInputsMap={toolInputsMap}
									sessionInfo={
										msg.uuid
											? (sessionInfoMap.get(msg.uuid) as SDKSystemMessage | undefined)
											: undefined
									}
									syntheticContent={msg.uuid ? compactSyntheticMap.get(msg.uuid) : undefined}
									skipSynthetic={msg.uuid ? skipSyntheticSet.has(msg.uuid) : false}
								/>
							))}

							{/* Render streaming events if present */}
							{streamingEvents.length > 0 && <SDKStreamingAccumulator events={streamingEvents} />}
						</div>
					)}

					<div ref={messagesEndRef} />
				</div>

				{/* Scroll to Bottom Button */}
				{showScrollButton && (
					<div class="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
						<button
							onClick={scrollToBottom}
							class={`w-10 h-10 rounded-full bg-dark-800 hover:bg-dark-700 text-gray-300 hover:text-gray-100 shadow-lg border ${borderColors.ui.secondary} flex items-center justify-center transition-all duration-150 animate-slideIn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
							title="Scroll to bottom"
							aria-label="Scroll to bottom"
						>
							<svg
								class="w-5 h-5"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								stroke-width="2"
							>
								<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
							</svg>
						</button>
					</div>
				)}
			</div>

			{/* Error Banner */}
			{error && (
				<div
					data-testid="error-banner"
					class={`bg-red-500/10 border-t ${borderColors.special.toast.error} px-4 py-3`}
				>
					<div class="max-w-4xl mx-auto w-full px-4 md:px-0 flex items-center justify-between gap-4">
						<p class="text-sm text-red-400 flex-1">{error}</p>
						<div class="flex items-center gap-2">
							{errorDetails && (
								<button
									onClick={() => setErrorDialogOpen(true)}
									class="text-xs px-3 py-1 rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-300 hover:text-red-200 transition-colors border border-red-500/30"
								>
									View Details
								</button>
							)}
							<button
								onClick={() => setError(null)}
								class="text-red-400 hover:text-red-300 transition-colors"
								aria-label="Dismiss error"
							>
								<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
									<path
										fill-rule="evenodd"
										d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
										clip-rule="evenodd"
									/>
								</svg>
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Session Status Bar */}
			<SessionStatusBar
				isProcessing={sending || streamingEvents.length > 0}
				currentAction={currentAction}
				streamingPhase={streamingPhase}
				contextUsage={contextUsage}
				maxContextTokens={200000}
			/>

			{/* Input Area or Archived Label */}
			{session?.status === 'archived' ? (
				<div class="p-4">
					<div class="max-w-4xl mx-auto">
						<div
							class={cn(
								'rounded-3xl border px-5 py-3 text-center',
								'bg-dark-800/60 backdrop-blur-sm',
								borderColors.ui.default
							)}
						>
							<span class="text-gray-400 text-sm flex items-center justify-center gap-2">
								<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
									/>
								</svg>
								Session archived
							</span>
						</div>
					</div>
				</div>
			) : (
				<MessageInput
					sessionId={sessionId}
					onSend={handleSendMessage}
					disabled={sending || isCompacting || connectionState.value !== 'connected'}
					autoScroll={autoScroll}
					onAutoScrollChange={handleAutoScrollChange}
					onOpenTools={() => setToolsModalOpen(true)}
				/>
			)}

			{/* Delete Chat Modal */}
			<Modal
				isOpen={deleteModalOpen}
				onClose={() => setDeleteModalOpen(false)}
				title="Delete Chat"
				size="sm"
			>
				<div class="space-y-4">
					<p class="text-gray-300 text-sm">
						Are you sure you want to delete this chat session? This action cannot be undone.
					</p>
					<div class="flex gap-3 justify-end">
						<Button variant="secondary" onClick={() => setDeleteModalOpen(false)}>
							Cancel
						</Button>
						<Button
							variant="danger"
							onClick={handleDeleteSession}
							data-testid="confirm-delete-session"
						>
							Delete Chat
						</Button>
					</div>
				</div>
			</Modal>

			{/* Archive Confirmation Dialog */}
			{archiveConfirmDialog?.show && archiveConfirmDialog.commitStatus && (
				<div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
					<div class={`bg-dark-800 border rounded-xl p-6 max-w-md mx-4 ${borderColors.ui.default}`}>
						<h3 class="text-lg font-semibold text-gray-100 mb-3">Confirm Archive</h3>
						<p class="text-sm text-gray-300 mb-4">
							This worktree has {archiveConfirmDialog.commitStatus.commits.length} uncommitted
							changes:
						</p>
						<div
							class={`bg-dark-900 rounded-lg p-3 mb-4 max-h-48 overflow-y-auto border ${borderColors.ui.secondary}`}
						>
							{archiveConfirmDialog.commitStatus.commits.map((commit) => (
								<div
									key={commit.hash}
									class="mb-2 text-xs pb-2 border-b border-dark-700 last:border-0 last:pb-0"
								>
									<div class="font-mono text-blue-400">{commit.hash}</div>
									<div class="text-gray-300">{commit.message}</div>
									<div class="text-gray-500">
										{commit.author} • {commit.date}
									</div>
								</div>
							))}
						</div>
						<p class="text-sm text-orange-400 mb-4">
							⚠️ These commits will be lost when the worktree is removed. Continue?
						</p>
						<div class="flex gap-3">
							<Button
								onClick={() => setArchiveConfirmDialog(null)}
								variant="secondary"
								class="flex-1"
							>
								Cancel
							</Button>
							<Button
								onClick={handleConfirmArchive}
								disabled={archiving}
								class="flex-1 bg-orange-500 hover:bg-orange-600 text-white"
							>
								{archiving ? 'Archiving...' : 'Archive Anyway'}
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* Tools Modal */}
			<ToolsModal
				isOpen={toolsModalOpen}
				onClose={() => setToolsModalOpen(false)}
				session={session}
			/>

			{/* Error Dialog */}
			<ErrorDialog
				isOpen={errorDialogOpen}
				onClose={() => setErrorDialogOpen(false)}
				error={errorDetails}
				isDev={import.meta.env.DEV === 'true' || import.meta.env.MODE === 'development'}
			/>
		</div>
	);
}
