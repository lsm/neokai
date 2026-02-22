/**
 * ChatContainer Component
 *
 * Main chat interface for displaying messages and handling user interaction.
 * Uses sessionStore as single source of truth for all session state.
 *
 * Architecture (Pure WebSocket):
 * - sessionStore: All session state (messages, errors, session info, context, agent state)
 * - Initial data: Fetched via RPC over WebSocket (no REST API)
 * - Updates: Real-time via state channel subscriptions
 * - Pagination: Loaded via RPC over WebSocket
 * - useSessionActions: Session actions (delete, archive, reset, export)
 *
 * NOTE: Stream events removed - the SDK's query() with AsyncGenerator yields
 * complete messages, not incremental tokens. Processing status shown via
 * agent state from state.session channel.
 */

import type { MessageImage, ResolvedQuestion, SessionFeatures } from '@neokai/shared';
import {
	DEFAULT_WORKER_FEATURES,
	DEFAULT_ROOM_CHAT_FEATURES,
	DEFAULT_ROOM_SELF_FEATURES,
} from '@neokai/shared';
import type { SDKMessage, SDKSystemMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useSignalEffect } from '@preact/signals';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArchiveConfirmDialog } from '../components/ArchiveConfirmDialog.tsx';
import { ChatHeader } from '../components/ChatHeader.tsx';
import { ErrorBanner } from '../components/ErrorBanner.tsx';
import { ErrorDialog } from '../components/ErrorDialog.tsx';
// Components
import MessageInput from '../components/MessageInput.tsx';
import { ScrollToBottomButton } from '../components/ScrollToBottomButton.tsx';
import { SessionInfoModal } from '../components/SessionInfoModal.tsx';
import SessionStatusBar from '../components/SessionStatusBar.tsx';
import { SDKMessageRenderer } from '../components/sdk/SDKMessageRenderer.tsx';
import { ToolsModal } from '../components/ToolsModal.tsx';
import { Button } from '../components/ui/Button.tsx';
import { ContentContainer } from '../components/ui/ContentContainer.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { Skeleton, SkeletonMessage } from '../components/ui/Skeleton.tsx';
import { Spinner } from '../components/ui/Spinner.tsx';
import { WorktreeChoiceInline } from '../components/WorktreeChoiceInline.tsx';
import { useAutoScroll } from '../hooks/useAutoScroll.ts';
import { useMessageMaps } from '../hooks/useMessageMaps.ts';
// Hooks
import { useModal } from '../hooks/useModal.ts';
import { useModelSwitcher } from '../hooks/useModelSwitcher.ts';
import { useSendMessage } from '../hooks/useSendMessage.ts';
import { useSessionActions } from '../hooks/useSessionActions.ts';
import { switchCoordinatorMode, switchSandboxMode, updateSession } from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager';
import { borderColors } from '../lib/design-tokens.ts';
import { sessionStore } from '../lib/session-store.ts';
import { connectionState } from '../lib/state.ts';
import { getCurrentAction } from '../lib/status-actions.ts';
import { toast } from '../lib/toast.ts';
import { cn } from '../lib/utils.ts';
import { contextPanelOpenSignal } from '../lib/signals.ts';

interface ChatContainerProps {
	sessionId: string;
	readonly?: boolean;
}

export default function ChatContainer({ sessionId, readonly = false }: ChatContainerProps) {
	// ========================================
	// Refs
	// ========================================
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	// Store scroll position info to restore after older messages are loaded
	const scrollPositionRestoreRef = useRef<{
		oldScrollHeight: number;
		oldScrollTop: number;
		shouldRestore: boolean;
	} | null>(null);

	// Ref for tracking resolving questions (sync updates, prevents form disappearance during transition)
	const resolvingQuestionsRef = useRef<Map<string, ResolvedQuestion>>(new Map());

	// ========================================
	// Local State (pagination, autoScroll)
	// ========================================
	const [loadingOlder, setLoadingOlder] = useState(false);
	// Initialize hasMoreMessages from sessionStore (inferred from initial load count)
	// This avoids an expensive COUNT query on every session load
	const [hasMoreMessages, setHasMoreMessages] = useState(sessionStore.hasMoreMessages.value);
	const [isInitialLoad, setIsInitialLoad] = useState(true);
	const [localError, setLocalError] = useState<string | null>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const [coordinatorMode, setCoordinatorMode] = useState(true);
	const [coordinatorSwitching, setCoordinatorSwitching] = useState(false);
	const [sandboxEnabled, setSandboxEnabled] = useState(true);
	const [sandboxSwitching, setSandboxSwitching] = useState(false);

	// Track resolved questions to keep showing them in disabled state
	// Map of toolUseId -> resolved question data
	// Initialized from session metadata and synced when session updates
	const [resolvedQuestions, setResolvedQuestions] = useState<Map<string, ResolvedQuestion>>(
		new Map()
	);

	// Rewind mode state
	const [rewindMode, setRewindMode] = useState(false);
	const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
	const [rewindModeChoice, setRewindModeChoice] = useState<'files' | 'conversation' | 'both'>(
		'both'
	);

	// Per-message rewind state
	const [rewindTargetUuid, setRewindTargetUuid] = useState<string | null>(null);
	const [isRewinding, setIsRewinding] = useState(false);

	// Worktree choice modal state
	const [showWorktreeChoice, setShowWorktreeChoice] = useState(false);
	const [pendingWorktreeMode, setPendingWorktreeMode] = useState<'worktree' | 'direct'>('worktree');

	// Reactive State from sessionStore (via useSignalEffect for re-renders)
	// Moved here before callbacks that depend on it
	const [messages, setMessages] = useState<SDKMessage[]>([]);
	const [session, setSession] = useState(sessionStore.sessionInfo.value);

	// ========================================
	// Modals
	// ========================================
	const deleteModal = useModal();
	const toolsModal = useModal();
	const infoModal = useModal();
	const errorDialog = useModal();
	const rewindConfirmModal = useModal();
	const selectiveRewindModal = useModal();

	// ========================================
	// Rewind handler
	// ========================================
	const handleRewindClick = useCallback(
		(uuid: string) => {
			setRewindTargetUuid(uuid);
			setRewindModeChoice('both');
			rewindConfirmModal.open();
		},
		[rewindConfirmModal]
	);

	const handleRewindConfirm = useCallback(async () => {
		if (!rewindTargetUuid) return;

		setIsRewinding(true);
		try {
			const { result } = await import('../lib/api-helpers.ts').then((m) =>
				m.executeRewind(sessionId, rewindTargetUuid, rewindModeChoice)
			);

			if (result.success) {
				toast.success(
					`Rewound successfully: ${result.messagesDeleted || 0} messages removed, ${
						result.filesChanged?.length || 0
					} files restored`
				);
				// Refresh session state to ensure data consistency
				await sessionStore.refresh();
			} else {
				toast.error(`Rewind failed: ${result.error || 'Unknown error'}`);
			}
		} catch (err) {
			toast.error(`Rewind failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		} finally {
			setIsRewinding(false);
			setRewindTargetUuid(null);
			rewindConfirmModal.close();
		}
	}, [rewindTargetUuid, sessionId, rewindModeChoice, rewindConfirmModal]);

	const handleRewindCancel = useCallback(() => {
		setRewindTargetUuid(null);
		rewindConfirmModal.close();
	}, [rewindConfirmModal]);

	// Rewind mode handlers
	const handleEnterRewindMode = useCallback(() => {
		setRewindMode(true);
		setSelectedMessages(new Set());
	}, []);

	const handleExitRewindMode = useCallback(() => {
		setRewindMode(false);
		setSelectedMessages(new Set());
	}, []);

	const handleMessageCheckboxChange = useCallback(
		(messageId: string, checked: boolean) => {
			const newSelected = new Set(selectedMessages);

			if (checked) {
				// Find message index and select all messages from this point onward
				const messageIndex = messages.findIndex((m) => m.uuid === messageId);
				for (let i = messageIndex; i < messages.length; i++) {
					if (messages[i].uuid) {
						newSelected.add(messages[i].uuid!);
					}
				}
			} else {
				// Unselect this message and all after it
				const messageIndex = messages.findIndex((m) => m.uuid === messageId);
				for (let i = messageIndex; i < messages.length; i++) {
					if (messages[i].uuid) {
						newSelected.delete(messages[i].uuid!);
					}
				}
			}

			setSelectedMessages(newSelected);
		},
		[selectedMessages, messages]
	);

	const handleRewindSelection = useCallback(() => {
		if (selectedMessages.size === 0) return;
		setRewindModeChoice('both'); // reset to default
		selectiveRewindModal.open();
	}, [selectedMessages, selectiveRewindModal]);

	const handleSelectiveRewindConfirm = useCallback(async () => {
		if (selectedMessages.size === 0) return;

		setIsRewinding(true);
		try {
			const { result } = await import('../lib/api-helpers.ts').then((m) =>
				m.executeSelectiveRewind(sessionId, Array.from(selectedMessages), rewindModeChoice)
			);

			if (result.success) {
				const parts = [];
				if (result.messagesDeleted) parts.push(`${result.messagesDeleted} messages removed`);
				if (result.filesReverted?.length)
					parts.push(`${result.filesReverted.length} files restored`);
				toast.success(`Rewound successfully: ${parts.join(', ')}`);
				// Refresh session state to ensure data consistency
				await sessionStore.refresh();
				handleExitRewindMode();
			} else {
				toast.error(`Rewind failed: ${result.error || 'Unknown error'}`);
			}
		} catch (err) {
			toast.error(`Rewind failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		} finally {
			setIsRewinding(false);
			selectiveRewindModal.close();
		}
	}, [selectedMessages, sessionId, rewindModeChoice, handleExitRewindMode, selectiveRewindModal]);

	// ========================================
	// Reactive State from sessionStore (via useSignalEffect for re-renders)
	// ========================================
	const [contextUsage, setContextUsage] = useState(sessionStore.contextInfo.value);
	const [agentState, setAgentState] = useState(sessionStore.agentState.value);
	const [storeError, setStoreError] = useState(sessionStore.error.value);

	// Sync messages from sessionStore
	useSignalEffect(() => {
		setMessages(sessionStore.sdkMessages.value);
	});

	// Sync session info from sessionStore
	useSignalEffect(() => {
		const info = sessionStore.sessionInfo.value;
		setSession(info);
		if (info?.config.autoScroll !== undefined) {
			setAutoScroll(info.config.autoScroll);
		}
		if (info?.config.coordinatorMode !== undefined) {
			setCoordinatorMode(info.config.coordinatorMode);
		}
		if (info?.config.sandbox?.enabled !== undefined) {
			setSandboxEnabled(info.config.sandbox.enabled);
		}
	});

	// Get feature flags from session config (for unified session architecture)
	// Falls back to appropriate defaults based on session type
	const features: SessionFeatures = useMemo(() => {
		if (session?.config?.features) {
			return session.config.features;
		}
		// Determine default features based on session ID format
		if (sessionId.startsWith('room:chat:')) {
			return DEFAULT_ROOM_CHAT_FEATURES;
		}
		if (sessionId.startsWith('room:self:')) {
			return DEFAULT_ROOM_SELF_FEATURES;
		}
		return DEFAULT_WORKER_FEATURES;
	}, [session?.config?.features, sessionId]);

	// Sync context from sessionStore
	useSignalEffect(() => {
		setContextUsage(sessionStore.contextInfo.value);
	});

	// Sync agent state from sessionStore
	useSignalEffect(() => {
		setAgentState(sessionStore.agentState.value);
	});

	// Sync error from sessionStore
	useSignalEffect(() => {
		setStoreError(sessionStore.error.value);
	});

	// Sync hasMoreMessages from sessionStore (inferred from initial load count)
	// This avoids an expensive COUNT query on every session load
	useSignalEffect(() => {
		setHasMoreMessages(sessionStore.hasMoreMessages.value);
	});

	// Track initial load state - set to false once session state RPC has returned
	useSignalEffect(() => {
		const hasMessages = sessionStore.sdkMessages.value.length > 0;
		const sessionStateLoaded = sessionStore.sessionState.value !== null;
		if (hasMessages || sessionStateLoaded) {
			setIsInitialLoad(false);
		}
	});

	// Sync resolved questions from session metadata when session loads/updates
	// Also clears resolvingQuestionsRef for items now confirmed by server
	useEffect(() => {
		if (session?.metadata?.resolvedQuestions) {
			const map = new Map<string, ResolvedQuestion>();
			for (const [toolUseId, resolved] of Object.entries(session.metadata.resolvedQuestions)) {
				map.set(toolUseId, resolved);
			}
			setResolvedQuestions(map);

			// Clear resolvingQuestionsRef for items now confirmed by server
			const refMap = resolvingQuestionsRef.current;
			for (const toolUseId of map.keys()) {
				refMap.delete(toolUseId);
			}
		}
	}, [session?.metadata?.resolvedQuestions]);

	// Show worktree choice modal if session is pending worktree choice
	useEffect(() => {
		if (
			session?.status === 'pending_worktree_choice' &&
			session?.metadata?.worktreeChoice?.status === 'pending'
		) {
			setShowWorktreeChoice(true);
		} else {
			setShowWorktreeChoice(false);
		}
	}, [session]);

	// Handler for worktree mode change
	const handleWorktreeModeChange = (mode: 'worktree' | 'direct') => {
		setPendingWorktreeMode(mode);
	};

	// Derived processing state
	const isProcessing = agentState.status === 'processing' || agentState.status === 'queued';
	const isCompacting =
		agentState.status === 'processing' &&
		'isCompacting' in agentState &&
		agentState.isCompacting === true;
	const isWaitingForInput = agentState.status === 'waiting_for_input';
	const pendingQuestion = isWaitingForInput ? agentState.pendingQuestion : null;

	// ========================================
	// Model Switcher
	// ========================================
	const {
		currentModel,
		currentModelInfo,
		availableModels,
		switching: modelSwitching,
		loading: modelLoading,
		switchModel,
	} = useModelSwitcher(sessionId);

	// Model switch with processing confirmation
	const handleModelSwitchWithConfirmation = useCallback(
		async (modelId: string) => {
			if (isProcessing) {
				const confirmed = confirm(
					'The agent is currently processing. Switching the model will interrupt the current operation. Continue?'
				);
				if (!confirmed) return;
			}
			await switchModel(modelId);
		},
		[switchModel, isProcessing]
	);

	// ========================================
	// Session Actions
	// ========================================
	const sessionActions = useSessionActions({
		sessionId,
		session,
		onDeleteModalClose: deleteModal.close,
		onStateReset: useCallback(() => {
			setLocalError(null);
			sessionStore.clearError();
		}, []),
	});

	// ========================================
	// Pagination (load older messages via RPC - pure WebSocket)
	// hasMoreMessages is inferred from initial load count in sessionStore
	// This avoids an expensive COUNT query on every session load
	// ========================================
	const loadOlderMessages = useCallback(async () => {
		if (loadingOlder || !hasMoreMessages || messages.length === 0) return;

		try {
			setLoadingOlder(true);

			const container = messagesContainerRef.current;
			if (!container) return;

			// Store current scroll position to restore after messages are prepended
			const oldScrollHeight = container.scrollHeight;
			const oldScrollTop = container.scrollTop;

			const oldestMessage = messages[0] as SDKMessage & { timestamp?: number };
			const beforeTimestamp = oldestMessage?.timestamp;
			if (!beforeTimestamp) {
				setHasMoreMessages(false);
				return;
			}

			// Load older messages via sessionStore RPC (pure WebSocket)
			const { messages: olderMessages, hasMore } =
				await sessionStore.loadOlderMessages(beforeTimestamp);
			if (olderMessages.length === 0) {
				setHasMoreMessages(false);
				return;
			}

			// Store scroll position info for restoration after DOM updates
			scrollPositionRestoreRef.current = {
				oldScrollHeight,
				oldScrollTop,
				shouldRestore: true,
			};

			// Prepend older messages to sessionStore (will trigger re-render)
			sessionStore.prependMessages(olderMessages);
			setHasMoreMessages(hasMore);
		} catch {
			toast.error('Failed to load older messages');
		} finally {
			setLoadingOlder(false);
		}
	}, [loadingOlder, hasMoreMessages, messages]);

	// ========================================
	// Send Message
	// ========================================
	const { sendMessage } = useSendMessage({
		sessionId,
		session,
		isSending: isProcessing,
		onSendStart: useCallback(() => {
			setLocalError(null);
			sessionStore.clearError();
		}, []),
		onSendComplete: useCallback(() => {
			// Completion handled by sessionStore state updates
		}, []),
		onError: useCallback((error: string) => {
			setLocalError(error);
		}, []),
	});

	// ========================================
	// Effects
	// ========================================

	// Select session on mount or when sessionId changes
	// This is needed when ChatContainer is used outside the main navigation flow
	// (e.g., in Room.tsx for room chat with sessionId="room:{roomId}")
	useEffect(() => {
		// Only select if this sessionId is different from the current active session
		if (sessionId && sessionId !== sessionStore.activeSessionId.value) {
			sessionStore.select(sessionId);
		}
		// Cleanup: deselect session when component unmounts
		return () => {
			// Only clear if we're the ones who selected this session
			if (sessionStore.activeSessionId.value === sessionId) {
				sessionStore.select(null);
			}
		};
	}, [sessionId]);

	// Restore scroll position after older messages are loaded and DOM has updated
	useEffect(() => {
		if (!scrollPositionRestoreRef.current?.shouldRestore) return;

		const { oldScrollHeight, oldScrollTop } = scrollPositionRestoreRef.current;
		const container = messagesContainerRef.current;

		if (!container) return;

		// Use multiple requestAnimationFrame calls to ensure DOM has fully updated
		// This is necessary because Preact's signal updates and DOM reflows are asynchronous
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (container) {
					// Calculate the new scroll position to maintain visual position
					// The scrollHeight has increased by the height of prepended messages
					const newScrollTop = oldScrollTop + (container.scrollHeight - oldScrollHeight);
					container.scrollTop = newScrollTop;
				}
				// Clear the restore flag
				scrollPositionRestoreRef.current = null;
			});
		});
	}, [messages.length, loadingOlder]);

	// ========================================
	// Auto-scroll
	// ========================================
	const { showScrollButton, scrollToBottom } = useAutoScroll({
		containerRef: messagesContainerRef,
		endRef: messagesEndRef,
		enabled: autoScroll,
		messageCount: messages.length,
		isInitialLoad,
		loadingOlder,
	});

	// ========================================
	// Message Maps (for tool results/inputs)
	// ========================================
	const removedOutputs = session?.metadata?.removedOutputs || [];
	const maps = useMessageMaps(messages, sessionId, removedOutputs);

	// Combined resolved questions map (state + ref)
	// Includes questions synced from server (state) and questions being resolved (ref)
	const allResolvedQuestions = useMemo(() => {
		const combined = new Map<string, ResolvedQuestion>(resolvedQuestions);
		for (const [toolUseId, resolved] of resolvingQuestionsRef.current) {
			combined.set(toolUseId, resolved);
		}
		return combined;
	}, [resolvedQuestions]);

	// ========================================
	// Connection Check
	// ========================================
	const isConnected = connectionState.value === 'connected';

	// ========================================
	// Handlers
	// ========================================
	const handleSendMessage = useCallback(
		async (content: string, images?: MessageImage[]) => {
			// If session is pending worktree choice, set the mode first
			if (session?.status === 'pending_worktree_choice' && showWorktreeChoice) {
				try {
					const hub = connectionManager.getHubIfConnected();
					if (!hub) {
						toast.error('Connection lost.');
						return;
					}
					await hub.request('session.setWorktreeMode', {
						sessionId,
						mode: pendingWorktreeMode,
					});
					// UI will auto-hide via session status update
				} catch {
					toast.error('Failed to set workspace mode');
					return; // Don't send message if worktree setup failed
				}
			}

			await sendMessage(content, images);
		},
		[sendMessage, session, showWorktreeChoice, pendingWorktreeMode, sessionId]
	);

	const handleAutoScrollChange = useCallback(
		async (newAutoScroll: boolean) => {
			setAutoScroll(newAutoScroll);
			try {
				await updateSession(sessionId, {
					config: { autoScroll: newAutoScroll },
				});
			} catch {
				setAutoScroll(!newAutoScroll);
				toast.error('Failed to save auto-scroll setting');
			}
		},
		[sessionId]
	);

	const handleCoordinatorModeChange = useCallback(
		async (newMode: boolean) => {
			if (isProcessing) {
				const confirmed = confirm(
					'The agent is currently processing. Changing coordinator mode will interrupt the current operation. Continue?'
				);
				if (!confirmed) return;
			}
			setCoordinatorSwitching(true);
			setCoordinatorMode(newMode);
			try {
				await switchCoordinatorMode(sessionId, newMode);
			} catch {
				setCoordinatorMode(!newMode);
				toast.error('Failed to toggle coordinator mode');
			} finally {
				setCoordinatorSwitching(false);
			}
		},
		[sessionId, isProcessing]
	);

	const handleSandboxModeChange = useCallback(
		async (newMode: boolean) => {
			if (isProcessing) {
				const confirmed = confirm(
					'The agent is currently processing. Changing sandbox mode will interrupt the current operation. Continue?'
				);
				if (!confirmed) return;
			}
			setSandboxSwitching(true);
			setSandboxEnabled(newMode);
			try {
				await switchSandboxMode(sessionId, newMode);
			} catch {
				setSandboxEnabled(!newMode);
				toast.error('Failed to toggle sandbox mode');
			} finally {
				setSandboxSwitching(false);
			}
		},
		[sessionId, isProcessing]
	);

	// ========================================
	// Display Stats
	// ========================================
	const displayStats = useMemo(() => {
		// All stats are calculated and persisted by daemon in session.metadata
		// UI should only display, never calculate
		// This ensures cost/token tracking is centralized in one place
		return {
			totalTokens: session?.metadata?.totalTokens ?? 0,
			totalCost: session?.metadata?.totalCost ?? 0,
		};
	}, [session?.metadata?.totalTokens, session?.metadata?.totalCost]);

	// ========================================
	// Derive currentAction and streamingPhase from agentState
	// Uses status-actions.ts for intelligent action detection
	// ========================================
	const { currentAction, streamingPhase } = useMemo(() => {
		// Handle queued state
		if (agentState.status === 'queued') {
			return { currentAction: 'Queued...', streamingPhase: null };
		}

		// Handle interrupted state
		if (agentState.status === 'interrupted') {
			return { currentAction: 'Interrupted', streamingPhase: null };
		}

		// Handle processing state
		if (agentState.status === 'processing') {
			const phase = agentState.phase;
			const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;

			// Use status-actions.ts to get intelligent action
			// Priority: compaction > tool-specific actions > phase-based actions > fallback
			const action = getCurrentAction(latestMessage, true, {
				isCompacting: agentState.isCompacting,
				streamingPhase: phase,
				streamingStartedAt: agentState.streamingStartedAt,
			});

			return { currentAction: action, streamingPhase: phase };
		}

		// Idle state
		return { currentAction: undefined, streamingPhase: null };
	}, [agentState, messages]);

	// Combined error (local + store)
	const error = localError || storeError?.message || null;

	// Derive loading state from sessionStore
	// sessionState being null means the RPC hasn't returned yet (truly loading)
	// session (sessionInfo) can be null even after RPC returns for room sessions
	const loading = sessionStore.sessionState.value === null && !error;

	// Render loading state
	if (loading) {
		return (
			<div class="flex-1 flex flex-col bg-dark-900">
				<div class={`bg-dark-850/50 backdrop-blur-sm border-b ${borderColors.ui.default} p-4`}>
					<div class="max-w-4xl mx-auto w-full px-4 md:px-0 flex items-center gap-3">
						{/* Hamburger menu button - visible only on mobile */}
						<button
							onClick={() => {
								contextPanelOpenSignal.value = true;
							}}
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
						<div class="flex-1 min-w-0">
							<Skeleton width="200px" height={24} class="mb-2" />
							<Skeleton width="150px" height={16} />
						</div>
					</div>
				</div>
				<div class="flex-1 overflow-y-auto">
					{Array.from({ length: 3 }).map((_, i) => (
						<SkeletonMessage key={i} />
					))}
				</div>
			</div>
		);
	}

	// Render error state (with retry via sessionStore re-selection)
	if (error && !session) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<div class="text-5xl mb-4">⚠️</div>
					<h3 class="text-lg font-semibold text-gray-100 mb-2">Failed to load session</h3>
					<p class="text-sm text-gray-400 mb-4">{error}</p>
					<Button onClick={() => sessionStore.select(sessionId)}>Retry</Button>
				</div>
			</div>
		);
	}

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden relative">
			{/* Loading overlay for archive/delete operations */}
			{(sessionActions.archiving || sessionActions.deleting) && (
				<div class="absolute inset-0 z-20 flex items-center justify-center bg-dark-900/80 backdrop-blur-sm">
					<div class="text-center">
						<Spinner size="lg" className="mx-auto mb-3" />
						<p class="text-sm text-gray-400">
							{sessionActions.deleting ? 'Deleting session...' : 'Archiving session...'}
						</p>
					</div>
				</div>
			)}

			{/* Header */}
			<ChatHeader
				session={session}
				displayStats={displayStats}
				features={features}
				onToolsClick={toolsModal.open}
				onInfoClick={infoModal.open}
				onExportClick={sessionActions.handleExportChat}
				onResetClick={sessionActions.handleResetAgent}
				onArchiveClick={sessionActions.handleArchiveClick}
				onDeleteClick={deleteModal.open}
				archiving={sessionActions.archiving}
				resettingAgent={sessionActions.resettingAgent}
				readonly={readonly}
			/>

			{/* Messages */}
			<div class="flex-1 relative min-h-0">
				{/* Rewind Mode Banner - only show if feature is enabled */}
				{features.rewind && rewindMode && (
					<div class="absolute top-0 left-0 right-0 z-20 bg-amber-500/10 backdrop-blur-sm border-b border-amber-500/30 px-4 py-3">
						<div class="max-w-4xl mx-auto flex items-center justify-between">
							<div class="flex items-center gap-3">
								<svg
									class="w-5 h-5 text-amber-400"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
									/>
								</svg>
								<span class="text-sm text-amber-200">
									{selectedMessages.size > 0
										? `${selectedMessages.size} message${selectedMessages.size > 1 ? 's' : ''} selected`
										: 'Select a message to rewind to'}
								</span>
							</div>
							<div class="flex items-center gap-2">
								{selectedMessages.size > 0 && (
									<button
										onClick={handleRewindSelection}
										disabled={isRewinding}
										class="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
									>
										{isRewinding && <Spinner size="xs" color="border-white" />}
										{isRewinding ? 'Rewinding...' : 'Rewind to Here'}
									</button>
								)}
								<button
									onClick={handleExitRewindMode}
									class="px-4 py-2 bg-dark-700 hover:bg-dark-600 text-gray-200 rounded-lg text-sm font-medium transition-colors"
								>
									Cancel
								</button>
							</div>
						</div>
					</div>
				)}

				<div
					ref={messagesContainerRef}
					data-messages-container
					class="absolute inset-0 overflow-y-scroll overscroll-contain touch-pan-y pb-32"
					style={{ WebkitOverflowScrolling: 'touch' }}
				>
					{/* Worktree Choice Inline */}
					{showWorktreeChoice && session && (
						<WorktreeChoiceInline
							sessionId={sessionId}
							workspacePath={session.workspacePath}
							onModeChange={handleWorktreeModeChange}
						/>
					)}

					{/* Loading overlay for rewind operation */}
					{isRewinding && (
						<div class="absolute inset-0 z-50 bg-dark-900/80 backdrop-blur-sm flex items-center justify-center">
							<div class="bg-dark-800 border border-amber-500/30 rounded-xl p-6 flex flex-col items-center gap-4 shadow-2xl">
								<Spinner size="lg" color="border-amber-500" />
								<div class="text-amber-200 text-sm font-medium">Rewinding conversation...</div>
								<div class="text-gray-400 text-xs">This may take a moment</div>
							</div>
						</div>
					)}
					{messages.length === 0 ? (
						<div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6">
							<div class="text-center">
								<div class="text-5xl mb-4">💬</div>
								<p class="text-lg text-gray-300 mb-2">No messages yet</p>
								<p class="text-sm text-gray-500">
									Start a conversation with Claude to see the magic happen
								</p>
							</div>
						</div>
					) : (
						<ContentContainer className="space-y-0 min-h-[calc(100%+1px)]">
							{/* Load More Button */}
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
												<Spinner size="sm" className="mr-2" />
												Loading...
											</>
										) : (
											'Load More Messages'
										)}
									</Button>
								</div>
							)}

							{!hasMoreMessages && messages.length > 0 && (
								<div class="flex items-center justify-center py-4">
									<div class="text-xs text-gray-500">Beginning of conversation</div>
								</div>
							)}

							{/* Messages - QuestionPrompt rendered inline with AskUserQuestion tool blocks */}
							{messages.map((msg, idx) => (
								<SDKMessageRenderer
									key={msg.uuid || `msg-${idx}`}
									message={msg}
									toolResultsMap={maps.toolResultsMap}
									toolInputsMap={maps.toolInputsMap}
									subagentMessagesMap={maps.subagentMessagesMap}
									sessionInfo={
										msg.uuid
											? (maps.sessionInfoMap.get(msg.uuid) as SDKSystemMessage | undefined)
											: undefined
									}
									sessionId={sessionId}
									resolvedQuestions={allResolvedQuestions}
									pendingQuestion={pendingQuestion}
									onRewind={handleRewindClick}
									rewindingMessageUuid={isRewinding ? rewindTargetUuid : null}
									rewindMode={rewindMode}
									selectedMessages={selectedMessages}
									onMessageCheckboxChange={handleMessageCheckboxChange}
									allMessages={messages}
									onQuestionResolved={(state, responses) => {
										// Move question to resolved state locally for immediate UI feedback
										// (Server also persists this via question.respond/cancel RPC)
										if (pendingQuestion) {
											const resolved = {
												question: pendingQuestion,
												state,
												responses,
												resolvedAt: Date.now(),
											};
											// Update ref immediately (synchronous)
											resolvingQuestionsRef.current.set(pendingQuestion.toolUseId, resolved);
											// Also schedule update to resolvedQuestions (will be merged with server data)
											setResolvedQuestions((prev) => {
												const next = new Map(prev);
												next.set(pendingQuestion.toolUseId, resolved);
												return next;
											});
										}
									}}
								/>
							))}
						</ContentContainer>
					)}

					<div ref={messagesEndRef} />
				</div>

				{/* Scroll Button - positioned relative to container, not scrollable content */}
				{showScrollButton && <ScrollToBottomButton onClick={() => scrollToBottom(true)} />}
			</div>

			{/* Error Banner */}
			{error && (
				<ErrorBanner
					error={error}
					hasDetails={!!storeError?.details}
					onViewDetails={errorDialog.open}
					onDismiss={() => {
						setLocalError(null);
						sessionStore.clearError();
					}}
				/>
			)}

			{/* Footer - Floating Status Bar */}
			<div class="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
				<div
					class="pointer-events-auto pt-4 bg-gradient-to-t from-dark-900 from-[calc(100%-32px)] to-dark-900/0"
					style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
				>
					<SessionStatusBar
						sessionId={sessionId}
						isProcessing={isProcessing}
						currentAction={currentAction}
						streamingPhase={streamingPhase}
						contextUsage={contextUsage ?? undefined}
						maxContextTokens={200000}
						features={features}
						currentModel={currentModel}
						currentModelInfo={currentModelInfo}
						availableModels={availableModels}
						modelSwitching={modelSwitching}
						modelLoading={modelLoading}
						onModelSwitch={handleModelSwitchWithConfirmation}
						autoScroll={autoScroll}
						onAutoScrollChange={handleAutoScrollChange}
						coordinatorMode={coordinatorMode}
						coordinatorSwitching={coordinatorSwitching}
						onCoordinatorModeChange={handleCoordinatorModeChange}
						sandboxEnabled={sandboxEnabled}
						sandboxSwitching={sandboxSwitching}
						onSandboxModeChange={handleSandboxModeChange}
						thinkingLevel={session?.config?.thinkingLevel}
					/>

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
						!readonly && (
							<MessageInput
								sessionId={sessionId}
								onSend={handleSendMessage}
								disabled={isProcessing || isCompacting || isWaitingForInput || !isConnected}
								autoScroll={autoScroll}
								onAutoScrollChange={handleAutoScrollChange}
								onOpenTools={toolsModal.open}
								onEnterRewindMode={handleEnterRewindMode}
								rewindMode={rewindMode}
								onExitRewindMode={handleExitRewindMode}
							/>
						)
					)}
				</div>
			</div>

			{/* Delete Modal */}
			<Modal isOpen={deleteModal.isOpen} onClose={deleteModal.close} title="Delete Chat" size="sm">
				<div class="space-y-4">
					<p class="text-gray-300 text-sm">
						Are you sure you want to delete this chat session? This action cannot be undone.
					</p>
					<div class="flex gap-3 justify-end">
						<Button
							variant="secondary"
							onClick={deleteModal.close}
							disabled={sessionActions.deleting}
						>
							Cancel
						</Button>
						<Button
							variant="danger"
							onClick={sessionActions.handleDeleteSession}
							loading={sessionActions.deleting}
							data-testid="confirm-delete-session"
						>
							Delete Chat
						</Button>
					</div>
				</div>
			</Modal>

			{/* Archive Confirmation */}
			{sessionActions.archiveConfirmDialog?.show &&
				sessionActions.archiveConfirmDialog.commitStatus && (
					<ArchiveConfirmDialog
						commitStatus={sessionActions.archiveConfirmDialog.commitStatus}
						archiving={sessionActions.archiving}
						onConfirm={sessionActions.handleConfirmArchive}
						onCancel={sessionActions.handleCancelArchive}
					/>
				)}

			{/* Tools Modal */}
			<ToolsModal isOpen={toolsModal.isOpen} onClose={toolsModal.close} session={session} />

			{/* Session Info Modal */}
			<SessionInfoModal isOpen={infoModal.isOpen} onClose={infoModal.close} session={session} />

			{/* Error Dialog */}
			<ErrorDialog
				isOpen={errorDialog.isOpen}
				onClose={errorDialog.close}
				error={sessionStore.getErrorDetails()}
				isDev={import.meta.env.DEV === 'true' || import.meta.env.MODE === 'development'}
			/>

			{/* Rewind Confirmation Modal */}
			<Modal
				isOpen={rewindConfirmModal.isOpen}
				onClose={handleRewindCancel}
				title="Rewind Conversation"
				size="sm"
			>
				<div class="space-y-4">
					<p class="text-gray-300 text-sm">
						This will rewind the conversation to before this message. Choose what to restore:
					</p>
					<div class="space-y-2">
						<label class="flex items-center gap-2 cursor-pointer">
							<input
								type="radio"
								name="perMessageRewindMode"
								value="both"
								checked={rewindModeChoice === 'both'}
								onChange={() => setRewindModeChoice('both')}
								class="text-amber-500 focus:ring-amber-500"
							/>
							<span class="text-sm text-gray-200">Files & Conversation</span>
						</label>
						<label class="flex items-center gap-2 cursor-pointer">
							<input
								type="radio"
								name="perMessageRewindMode"
								value="files"
								checked={rewindModeChoice === 'files'}
								onChange={() => setRewindModeChoice('files')}
								class="text-amber-500 focus:ring-amber-500"
							/>
							<span class="text-sm text-gray-200">Files only</span>
						</label>
						<label class="flex items-center gap-2 cursor-pointer">
							<input
								type="radio"
								name="perMessageRewindMode"
								value="conversation"
								checked={rewindModeChoice === 'conversation'}
								onChange={() => setRewindModeChoice('conversation')}
								class="text-amber-500 focus:ring-amber-500"
							/>
							<span class="text-sm text-gray-200">Conversation only</span>
						</label>
					</div>
					<p class="text-amber-400 text-xs">This action cannot be undone.</p>
					<div class="flex gap-3 justify-end">
						<Button variant="secondary" onClick={handleRewindCancel} disabled={isRewinding}>
							Cancel
						</Button>
						<Button variant="danger" onClick={handleRewindConfirm} loading={isRewinding}>
							{isRewinding ? 'Rewinding...' : 'Rewind'}
						</Button>
					</div>
				</div>
			</Modal>

			{/* Selective Rewind Modal */}
			<Modal
				isOpen={selectiveRewindModal.isOpen}
				onClose={() => {
					if (!isRewinding) selectiveRewindModal.close();
				}}
				title="Rewind Conversation"
				size="sm"
			>
				<div class="space-y-4">
					<p class="text-gray-300 text-sm">
						This will rewind the conversation to the selected point. Choose what to restore:
					</p>
					<div class="space-y-2">
						<label class="flex items-center gap-2 cursor-pointer">
							<input
								type="radio"
								name="rewindMode"
								value="both"
								checked={rewindModeChoice === 'both'}
								onChange={() => setRewindModeChoice('both')}
								class="text-amber-500 focus:ring-amber-500"
							/>
							<span class="text-sm text-gray-200">Files & Conversation</span>
						</label>
						<label class="flex items-center gap-2 cursor-pointer">
							<input
								type="radio"
								name="rewindMode"
								value="files"
								checked={rewindModeChoice === 'files'}
								onChange={() => setRewindModeChoice('files')}
								class="text-amber-500 focus:ring-amber-500"
							/>
							<span class="text-sm text-gray-200">Files only</span>
						</label>
						<label class="flex items-center gap-2 cursor-pointer">
							<input
								type="radio"
								name="rewindMode"
								value="conversation"
								checked={rewindModeChoice === 'conversation'}
								onChange={() => setRewindModeChoice('conversation')}
								class="text-amber-500 focus:ring-amber-500"
							/>
							<span class="text-sm text-gray-200">Conversation only</span>
						</label>
					</div>
					<p class="text-amber-400 text-xs">This action cannot be undone.</p>
					<div class="flex gap-3 justify-end">
						<Button
							variant="secondary"
							onClick={() => selectiveRewindModal.close()}
							disabled={isRewinding}
						>
							Cancel
						</Button>
						<Button variant="danger" onClick={handleSelectiveRewindConfirm} loading={isRewinding}>
							{isRewinding ? 'Rewinding...' : 'Rewind'}
						</Button>
					</div>
				</div>
			</Modal>
		</div>
	);
}
