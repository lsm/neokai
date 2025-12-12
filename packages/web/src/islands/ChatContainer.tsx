import { useEffect, useRef, useState } from 'preact/hooks';
import type {
	Session,
	ContextInfo,
	ContextCategoryBreakdown,
	ContextSlashCommandTool,
} from '@liuboer/shared';
import type { SDKMessage, SDKSystemMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import { isSDKStreamEvent } from '@liuboer/shared/sdk/type-guards';
import { connectionManager } from '../lib/connection-manager.ts';
import {
	getSession,
	getSDKMessages,
	getMessageCount,
	getSlashCommands,
	deleteSession,
	listSessions,
	updateSession,
} from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
// import { generateUUID } from '../lib/utils.ts';
import {
	currentSessionIdSignal,
	sessionsSignal,
	sidebarOpenSignal,
	slashCommandsSignal,
} from '../lib/signals.ts';
import { connectionState } from '../lib/state.ts';
import MessageInput from '../components/MessageInput.tsx';
import StatusIndicator from '../components/StatusIndicator.tsx';
import { Button } from '../components/ui/Button.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { Skeleton, SkeletonMessage } from '../components/ui/Skeleton.tsx';
import { SDKMessageRenderer } from '../components/sdk/SDKMessageRenderer.tsx';
import { SDKStreamingAccumulator } from '../components/sdk/SDKStreamingMessage.tsx';
import { getCurrentAction } from '../lib/status-actions.ts';

interface ChatContainerProps {
	sessionId: string;
}

export default function ChatContainer({ sessionId }: ChatContainerProps) {
	console.log('ChatContainer rendering with sessionId:', sessionId);

	const [session, setSession] = useState<Session | null>(null);
	const [messages, setMessages] = useState<SDKMessage[]>([]);
	const [streamingEvents, setStreamingEvents] = useState<
		Extract<SDKMessage, { type: 'stream_event' }>[]
	>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [showScrollButton, setShowScrollButton] = useState(false);
	const [deleteModalOpen, setDeleteModalOpen] = useState(false);
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

	useEffect(() => {
		// Reset state when switching sessions
		setSending(false);
		setError(null);
		setCurrentAction(undefined);
		setStreamingEvents([]);
		setStreamingPhase(null);
		setIsCompacting(false);

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
		connectionManager
			.getHub()
			.then(async (hub) => {
				// Only subscribe if component is still mounted
				if (!isMounted) return;

				// SDK message events - PRIMARY EVENT HANDLER
				const unsubSDKMessage = await hub.subscribe<SDKMessage>(
					'sdk.message',
					(sdkMessage) => {
						console.log('Received SDK message:', sdkMessage.type, sdkMessage);

						// Extract slash commands from SDK init message
						if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
							const initMessage = sdkMessage as Record<string, unknown> as Record<string, unknown>;
							if (initMessage.slash_commands && Array.isArray(initMessage.slash_commands)) {
								console.log('Extracted slash commands from SDK:', initMessage.slash_commands);
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
							setMessages((prev) => {
								if (sdkMessage.uuid) {
									const existingIndex = prev.findIndex((m) => m.uuid === sdkMessage.uuid);
									if (existingIndex !== -1) {
										const updated = [...prev];
										updated[existingIndex] = sdkMessage;
										return updated;
									}
								}
								return [...prev, sdkMessage];
							});
						}
					},
					{ sessionId }
				);
				if (!isMounted) return;
				cleanupFunctions.push(unsubSDKMessage);

				// Context events
				const unsubContextUpdated = await hub.subscribe<unknown>(
					'context.updated',
					(data) => {
						const ctx = data as Record<string, unknown>;
						console.log(`Context updated:`, ctx);
						if (ctx.totalUsed !== undefined) {
							console.log(`Received accurate context info:`, {
								totalUsed: ctx.totalUsed as number,
								totalCapacity: ctx.totalCapacity as number,
								percentUsed: ctx.percentUsed as number,
								breakdown: ctx.breakdown as Record<string, ContextCategoryBreakdown>,
							});
							setContextUsage({
								totalUsed: ctx.totalUsed as number,
								totalCapacity: ctx.totalCapacity as number,
								percentUsed: ctx.percentUsed as number,
								breakdown: ctx.breakdown as Record<string, ContextCategoryBreakdown>,
								model: ctx.model as string | null,
								slashCommandTool: ctx.slashCommandTool as ContextSlashCommandTool | undefined,
							});
						}
					},
					{ sessionId }
				);
				if (!isMounted) return;
				cleanupFunctions.push(unsubContextUpdated);

				// Subscribe to compaction start - lock input and show toast
				const unsubContextCompacting = await hub.subscribe<{ trigger: 'manual' | 'auto' }>(
					'context.compacting',
					(data) => {
						const triggerText = data.trigger === 'auto' ? 'Auto-compacting' : 'Compacting';
						setIsCompacting(true);
						setCurrentAction(`${triggerText} context...`);
						toast.info(`${triggerText} context to free up space...`);
					},
					{ sessionId }
				);
				if (!isMounted) return;
				cleanupFunctions.push(unsubContextCompacting);

				// Subscribe to compaction complete - unlock input and show result
				const unsubContextCompacted = await hub.subscribe<{
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
				if (!isMounted) return;
				cleanupFunctions.push(unsubContextCompacted);

				// Error handling
				const unsubSessionError = await hub.subscribe<{ error: string }>(
					'session.error',
					(data) => {
						const error = data.error;
						setError(error);
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
				if (!isMounted) return;
				cleanupFunctions.push(unsubSessionError);

				// Subscribe to unified session state (includes agent state and commands)
				const unsubSessionState = await hub.subscribe<{
					session: unknown;
					agent: {
						status: 'idle' | 'queued' | 'processing' | 'interrupted';
						messageId?: string;
						phase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing';
						streamingStartedAt?: number;
					};
					commands: { availableCommands: string[] };
					context: unknown;
				}>(
					'state.session',
					(data) => {
						console.log('Received unified session state:', data);

						// Update commands
						if (data.commands?.availableCommands) {
							slashCommandsSignal.value = data.commands.availableCommands;
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
				if (!isMounted) return;
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
		// - Always scroll on initial load to show latest messages
		// - Only scroll on new messages if autoScroll is enabled
		// - Never scroll when loading older messages (loadingOlder prevents unwanted scroll)
		if (isInitialLoad) {
			scrollToBottom();
		} else if (autoScroll && !loadingOlder) {
			scrollToBottom();
		}
	}, [messages, streamingEvents, isInitialLoad, loadingOlder, autoScroll]);

	// Detect scroll position and load older messages when scrolling to top
	useEffect(() => {
		const container = messagesContainerRef.current;
		if (!container) return;

		const handleScroll = () => {
			const { scrollTop, scrollHeight, clientHeight } = container;
			const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;
			const isNearTop = scrollTop < 100;

			setShowScrollButton(!isNearBottom);

			// Load older messages when scrolling near the top
			if (isNearTop && !loadingOlder && hasMoreMessages && messages.length > 0) {
				loadOlderMessages();
			}
		};

		container.addEventListener('scroll', handleScroll);
		return () => container.removeEventListener('scroll', handleScroll);
	}, [loadingOlder, hasMoreMessages, messages.length]);

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
			setMessages(sdkResponse.sdkMessages as SDKMessage[]);

			// Use actual count to determine if there are more messages
			setHasMoreMessages(sdkResponse.sdkMessages.length < countResponse.count);

			// Load slash commands for this session
			try {
				const commandsResponse = await getSlashCommands(sessionId);
				if (commandsResponse.commands && commandsResponse.commands.length > 0) {
					console.log('Loaded slash commands:', commandsResponse.commands);
					slashCommandsSignal.value = commandsResponse.commands;
				}
			} catch (cmdError) {
				// Slash commands might not be available yet (needs first message)
				console.log('Slash commands not yet available:', cmdError);
			}

			// Context usage will be populated from context.updated events
			// No need to calculate from API response messages

			// Mark initial load complete after a short delay to ensure scroll happens
			setTimeout(() => setIsInitialLoad(false), 100);
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
			setMessages((prev) => [...(sdkResponse.sdkMessages as SDKMessage[]), ...prev]);

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

	const handleSendMessage = async (content: string) => {
		if (!content.trim() || sending) return;

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
			const hub = await connectionManager.getHub();
			await hub.call('message.send', {
				sessionId,
				content,
				// images: undefined, // Future: support image uploads
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

	const getHeaderActions = () => [
		{
			label: 'Session Settings',
			onClick: () => toast.info('Session settings coming soon'),
			icon: (
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
					/>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
					/>
				</svg>
			),
		},
		{
			label: 'Export Chat',
			onClick: () => toast.info('Export feature coming soon'),
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
			label: 'Delete Chat',
			onClick: () => setDeleteModalOpen(true),
			danger: true,
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
				<div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4">
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
	const toolResultsMap = new Map<string, unknown>();
	messages.forEach((msg) => {
		if (msg.type === 'user' && Array.isArray(msg.message.content)) {
			msg.message.content.forEach((block: unknown) => {
				if ((block as Record<string, unknown>).type === 'tool_result') {
					toolResultsMap.set((block as Record<string, unknown>).tool_use_id as string, block);
				}
			});
		}
	});

	// Create a map of tool use IDs to tool inputs for easy lookup
	const toolInputsMap = new Map<string, unknown>();
	messages.forEach((msg) => {
		if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
			msg.message.content.forEach((block: unknown) => {
				if ((block as Record<string, unknown>).type === 'tool_use') {
					toolInputsMap.set(
						(block as Record<string, unknown>).id as string,
						(block as Record<string, unknown>).input
					);
				}
			});
		}
	});

	// Create a map of user message UUIDs to their attached session init info
	// Session init messages appear after the first user message, so we attach them to the preceding user message
	const sessionInfoMap = new Map<string, unknown>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.type === 'system' && msg.subtype === 'init') {
			// Find the most recent user message before this session init
			for (let j = i - 1; j >= 0; j--) {
				if (messages[j].type === 'user' && messages[j].uuid) {
					sessionInfoMap.set(messages[j].uuid!, msg);
					break;
				}
			}
			// If no preceding user message, attach to the first user message after this session init
			if (msg.uuid && !sessionInfoMap.has(msg.uuid)) {
				for (let j = i + 1; j < messages.length; j++) {
					if (messages[j].type === 'user' && messages[j].uuid) {
						sessionInfoMap.set(messages[j].uuid!, msg);
						break;
					}
				}
			}
		}
	}

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-x-hidden">
			{/* Header */}
			<div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4">
				<div class="max-w-4xl mx-auto w-full px-4 md:px-0 flex items-center gap-3">
					{/* Hamburger menu button - visible only on mobile */}
					<button
						onClick={handleMenuClick}
						class="md:hidden p-2 -ml-2 bg-dark-850 border border-dark-700 rounded-lg hover:bg-dark-800 transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0"
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
							<span class="flex items-center gap-1" title="Input tokens">
								<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M7 11l5-5m0 0l5 5m-5-5v12"
									/>
								</svg>
								{displayStats.inputTokens.toLocaleString()}
							</span>
							<span class="flex items-center gap-1" title="Output tokens">
								<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M17 13l-5 5m0 0l-5-5m5 5V6"
									/>
								</svg>
								{displayStats.outputTokens.toLocaleString()}
							</span>
							<span class="text-gray-500">({displayStats.totalTokens.toLocaleString()} total)</span>
							<span class="text-gray-500">•</span>
							<span class="font-mono text-green-400">${displayStats.totalCost.toFixed(4)}</span>
						</div>
					</div>

					{/* Options dropdown */}
					<Dropdown
						trigger={
							<IconButton title="Session options">
								<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
									<path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
								</svg>
							</IconButton>
						}
						items={getHeaderActions()}
					/>
				</div>
			</div>

			{/* Messages */}
			<div ref={messagesContainerRef} class="flex-1 overflow-y-auto">
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
						{/* Loading indicator for older messages */}
						{loadingOlder && (
							<div class="flex items-center justify-center py-4">
								<div class="flex items-center gap-2 text-sm text-gray-400">
									<svg class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
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
									<span>Loading older messages...</span>
								</div>
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
				<div class="absolute bottom-28 right-8">
					<IconButton
						onClick={scrollToBottom}
						variant="solid"
						size="lg"
						class="shadow-lg animate-slideIn"
						title="Scroll to bottom"
					>
						<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M19 14l-7 7m0 0l-7-7m7 7V3"
							/>
						</svg>
					</IconButton>
				</div>
			)}

			{/* Error Banner */}
			{error && (
				<div data-testid="error-banner" class="bg-red-500/10 border-t border-red-500/20 px-4 py-3">
					<div class="max-w-4xl mx-auto w-full px-4 md:px-0 flex items-center justify-between">
						<p class="text-sm text-red-400">{error}</p>
						<button
							onClick={() => setError(null)}
							class="text-red-400 hover:text-red-300 transition-colors"
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
			)}

			{/* Status Indicator */}
			<StatusIndicator
				connectionState={connectionState.value}
				isProcessing={sending || streamingEvents.length > 0}
				currentAction={currentAction}
				streamingPhase={streamingPhase}
				contextUsage={contextUsage}
				maxContextTokens={200000}
				onSendMessage={handleSendMessage}
			/>

			{/* Input */}
			<MessageInput
				sessionId={sessionId}
				onSend={handleSendMessage}
				disabled={sending || isCompacting || connectionState.value !== 'connected'}
				autoScroll={autoScroll}
				onAutoScrollChange={handleAutoScrollChange}
			/>

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
		</div>
	);
}
