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

import { useEffect, useRef, useCallback, useMemo, useState } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import type { MessageImage } from '@liuboer/shared';
import type { SDKMessage, SDKSystemMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import { updateSession } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import { cn } from '../lib/utils.ts';
import { connectionState } from '../lib/state.ts';
import { borderColors } from '../lib/design-tokens.ts';
import { sessionStore } from '../lib/session-store.ts';
import { currentSessionIdSignal } from '../lib/signals.ts';

// Hooks
import { useModal } from '../hooks/useModal.ts';
import { useAutoScroll } from '../hooks/useAutoScroll.ts';
import { useMessageMaps } from '../hooks/useMessageMaps.ts';
import { useSessionActions } from '../hooks/useSessionActions.ts';
import { useSendMessage } from '../hooks/useSendMessage.ts';
import { useModelSwitcher } from '../hooks/useModelSwitcher.ts';

// Components
import MessageInput from '../components/MessageInput.tsx';
import SessionStatusBar from '../components/SessionStatusBar.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { ContentContainer } from '../components/ui/ContentContainer.tsx';
import { ToolsModal } from '../components/ToolsModal.tsx';
import { Skeleton, SkeletonMessage } from '../components/ui/Skeleton.tsx';
import { SDKMessageRenderer } from '../components/sdk/SDKMessageRenderer.tsx';
import { ErrorDialog } from '../components/ErrorDialog.tsx';
import { ChatHeader } from '../components/ChatHeader.tsx';
import { Spinner } from '../components/ui/Spinner.tsx';
import { ArchiveConfirmDialog } from '../components/ArchiveConfirmDialog.tsx';
import { ErrorBanner } from '../components/ErrorBanner.tsx';
import { ScrollToBottomButton } from '../components/ScrollToBottomButton.tsx';

interface ChatContainerProps {
	sessionId: string;
}

export default function ChatContainer({ sessionId }: ChatContainerProps) {
	// ========================================
	// Refs
	// ========================================
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);

	// ========================================
	// Local State (pagination, autoScroll)
	// ========================================
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [hasMoreMessages, setHasMoreMessages] = useState(true);
	const [isInitialLoad, setIsInitialLoad] = useState(true);
	const [localError, setLocalError] = useState<string | null>(null);
	const [autoScroll, setAutoScroll] = useState(false);

	// ========================================
	// Modals
	// ========================================
	const deleteModal = useModal();
	const toolsModal = useModal();
	const errorDialog = useModal();

	// ========================================
	// Reactive State from sessionStore (via useSignalEffect for re-renders)
	// ========================================
	const [messages, setMessages] = useState<SDKMessage[]>([]);
	const [session, setSession] = useState(sessionStore.sessionInfo.value);
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
	});

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

	// Derived processing state
	const isProcessing = agentState.status === 'processing' || agentState.status === 'queued';
	const isCompacting =
		agentState.status === 'processing' &&
		'isCompacting' in agentState &&
		agentState.isCompacting === true;

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
	// Pagination Check (on session load)
	// ========================================
	const checkPagination = useCallback(async () => {
		try {
			setIsInitialLoad(true);
			setLocalError(null);

			// Get total message count via RPC for pagination
			const totalCount = await sessionStore.getTotalMessageCount();
			setHasMoreMessages(totalCount > 100);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to load session';
			if (message.includes('Session not found') || message.includes('404')) {
				currentSessionIdSignal.value = null;
				toast.error('Session not found.');
				return;
			}
			setLocalError(message);
		}
	}, []);

	// ========================================
	// Pagination (load older messages via RPC - pure WebSocket)
	// ========================================
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

			// Load older messages via sessionStore RPC (pure WebSocket)
			const { messages: olderMessages, hasMore } =
				await sessionStore.loadOlderMessages(beforeTimestamp);
			if (olderMessages.length === 0) {
				setHasMoreMessages(false);
				return;
			}

			// Prepend older messages to sessionStore
			sessionStore.prependMessages(olderMessages);
			setHasMoreMessages(hasMore);

			// Restore scroll position
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

	// Check pagination on mount / session change
	// Initial data is loaded via sessionStore.select() in App.tsx
	useEffect(() => {
		checkPagination();
	}, [sessionId, checkPagination]);

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

	// ========================================
	// Connection Check
	// ========================================
	const isConnected = connectionState.value === 'connected';

	// ========================================
	// Handlers
	// ========================================
	const handleSendMessage = useCallback(
		async (content: string, images?: MessageImage[]) => {
			await sendMessage(content, images);
		},
		[sendMessage]
	);

	const handleAutoScrollChange = useCallback(
		async (newAutoScroll: boolean) => {
			setAutoScroll(newAutoScroll);
			try {
				await updateSession(sessionId, { config: { autoScroll: newAutoScroll } });
			} catch (err) {
				setAutoScroll(!newAutoScroll);
				toast.error('Failed to save auto-scroll setting');
				console.error('Failed to update autoScroll:', err);
			}
		},
		[sessionId]
	);

	// ========================================
	// Display Stats
	// ========================================
	const displayStats = useMemo(() => {
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

		return {
			totalTokens:
				session?.metadata?.totalTokens ??
				accumulatedStats.inputTokens + accumulatedStats.outputTokens,
			totalCost: session?.metadata?.totalCost ?? accumulatedStats.totalCost,
		};
	}, [messages, session?.metadata?.totalTokens, session?.metadata?.totalCost]);

	// ========================================
	// Derive currentAction and streamingPhase from agentState
	// ========================================
	const { currentAction, streamingPhase } = useMemo(() => {
		if (agentState.status === 'processing') {
			const phase = agentState.phase;
			let action = 'Processing...';
			if (agentState.isCompacting) {
				action = 'Compacting context...';
			} else {
				switch (phase) {
					case 'initializing':
						action = 'Starting...';
						break;
					case 'thinking':
						action = 'Thinking...';
						break;
					case 'streaming': {
						const duration = agentState.streamingStartedAt
							? Math.floor((Date.now() - agentState.streamingStartedAt) / 1000)
							: 0;
						action = duration > 0 ? `Streaming (${duration}s)...` : 'Streaming...';
						break;
					}
					case 'finalizing':
						action = 'Finalizing...';
						break;
				}
			}
			return { currentAction: action, streamingPhase: phase };
		}
		if (agentState.status === 'queued') {
			return { currentAction: 'Queued...', streamingPhase: null };
		}
		if (agentState.status === 'interrupted') {
			return { currentAction: 'Interrupted', streamingPhase: null };
		}
		return { currentAction: undefined, streamingPhase: null };
	}, [agentState]);

	// Combined error (local + store)
	const error = localError || storeError?.message || null;

	// Derive loading state from sessionStore (session is null means still loading)
	const loading = session === null && !error;

	// Render loading state
	if (loading) {
		return (
			<div class="flex-1 flex flex-col bg-dark-900">
				<div class={`bg-dark-850/50 backdrop-blur-sm border-b ${borderColors.ui.default} p-4`}>
					<Skeleton width="200px" height={24} class="mb-2" />
					<Skeleton width="150px" height={16} />
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
			{/* Header */}
			<ChatHeader
				session={session}
				displayStats={displayStats}
				onToolsClick={toolsModal.open}
				onExportClick={sessionActions.handleExportChat}
				onResetClick={sessionActions.handleResetAgent}
				onArchiveClick={sessionActions.handleArchiveClick}
				onDeleteClick={deleteModal.open}
				archiving={sessionActions.archiving}
				resettingAgent={sessionActions.resettingAgent}
			/>

			{/* Messages */}
			<div class="flex-1 relative min-h-0">
				<div
					ref={messagesContainerRef}
					data-messages-container
					class="absolute inset-0 overflow-y-scroll overscroll-contain touch-pan-y"
					style={{ WebkitOverflowScrolling: 'touch' }}
				>
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

							{/* Messages */}
							{messages.map((msg, idx) => (
								<SDKMessageRenderer
									key={msg.uuid || `msg-${idx}`}
									message={msg}
									toolResultsMap={maps.toolResultsMap}
									toolInputsMap={maps.toolInputsMap}
									sessionInfo={
										msg.uuid
											? (maps.sessionInfoMap.get(msg.uuid) as SDKSystemMessage | undefined)
											: undefined
									}
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

			{/* Footer */}
			<div class="flex-shrink-0">
				<SessionStatusBar
					sessionId={sessionId}
					isProcessing={isProcessing}
					currentAction={currentAction}
					streamingPhase={streamingPhase}
					contextUsage={contextUsage ?? undefined}
					maxContextTokens={200000}
					currentModel={currentModel}
					currentModelInfo={currentModelInfo}
					availableModels={availableModels}
					modelSwitching={modelSwitching}
					modelLoading={modelLoading}
					onModelSwitch={switchModel}
					autoScroll={autoScroll}
					onAutoScrollChange={handleAutoScrollChange}
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
					<MessageInput
						sessionId={sessionId}
						onSend={handleSendMessage}
						disabled={isProcessing || isCompacting || !isConnected}
						autoScroll={autoScroll}
						onAutoScrollChange={handleAutoScrollChange}
						onOpenTools={toolsModal.open}
					/>
				)}
			</div>

			{/* Delete Modal */}
			<Modal isOpen={deleteModal.isOpen} onClose={deleteModal.close} title="Delete Chat" size="sm">
				<div class="space-y-4">
					<p class="text-gray-300 text-sm">
						Are you sure you want to delete this chat session? This action cannot be undone.
					</p>
					<div class="flex gap-3 justify-end">
						<Button variant="secondary" onClick={deleteModal.close}>
							Cancel
						</Button>
						<Button
							variant="danger"
							onClick={sessionActions.handleDeleteSession}
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

			{/* Error Dialog */}
			<ErrorDialog
				isOpen={errorDialog.isOpen}
				onClose={errorDialog.close}
				error={sessionStore.getErrorDetails()}
				isDev={import.meta.env.DEV === 'true' || import.meta.env.MODE === 'development'}
			/>
		</div>
	);
}
