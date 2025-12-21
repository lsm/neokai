/**
 * ChatContainer Component
 *
 * Main chat interface for displaying messages and handling user interaction.
 * Refactored to use extracted hooks and components for better separation of concerns.
 */

import { useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import type { MessageImage, Session, ContextInfo } from '@liuboer/shared';
import type { SDKMessage, SDKSystemMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import { updateSession } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import { cn } from '../lib/utils.ts';
import { connectionState } from '../lib/state.ts';
import { borderColors } from '../lib/design-tokens.ts';

// Hooks
import { useModal } from '../hooks/useModal.ts';
import { useAutoScroll } from '../hooks/useAutoScroll.ts';
import { useMessageMaps } from '../hooks/useMessageMaps.ts';
import { useMessageLoader } from '../hooks/useMessageLoader.ts';
import { useSessionActions } from '../hooks/useSessionActions.ts';
import { useSessionSubscriptions } from '../hooks/useSessionSubscriptions.ts';
import { useSendMessage } from '../hooks/useSendMessage.ts';

// Components
import MessageInput from '../components/MessageInput.tsx';
import SessionStatusBar from '../components/SessionStatusBar.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { ContentContainer } from '../components/ui/ContentContainer.tsx';
import { ToolsModal } from '../components/ToolsModal.tsx';
import { Skeleton, SkeletonMessage } from '../components/ui/Skeleton.tsx';
import { SDKMessageRenderer } from '../components/sdk/SDKMessageRenderer.tsx';
import { SDKStreamingAccumulator } from '../components/sdk/SDKStreamingMessage.tsx';
import { ErrorDialog } from '../components/ErrorDialog.tsx';
import type { StructuredError } from '../types/error.ts';
import { ChatHeader } from '../components/ChatHeader.tsx';
import { Spinner } from '../components/ui/Spinner.tsx';
import { ArchiveConfirmDialog } from '../components/ArchiveConfirmDialog.tsx';
import { ErrorBanner } from '../components/ErrorBanner.tsx';
import { ScrollToBottomButton } from '../components/ScrollToBottomButton.tsx';

interface ChatContainerProps {
	sessionId: string;
}

export default function ChatContainer({ sessionId }: ChatContainerProps) {
	// Refs
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const errorDetailsRef = useRef<StructuredError | null>(null);

	// Modals
	const deleteModal = useModal();
	const toolsModal = useModal();
	const errorDialog = useModal();

	// Message loader hook
	const messageLoader = useMessageLoader({
		sessionId,
		messagesContainerRef,
	});

	// Session actions hook
	const sessionActions = useSessionActions({
		sessionId,
		session: messageLoader.session,
		onDeleteModalClose: deleteModal.close,
		onStateReset: useCallback(() => {
			messageLoader.setError(null);
		}, [messageLoader]),
	});

	// Subscription callbacks
	const subscriptionCallbacks = useMemo(
		() => ({
			onSessionUpdate: (session: Session) => {
				messageLoader.setSession(session);
				messageLoader.setAutoScroll(session.config.autoScroll ?? false);
			},
			onContextUpdate: (context: ContextInfo) => {
				messageLoader.setContextUsage(context);
			},
			onMessageReceived: (message: SDKMessage) => {
				messageLoader.addMessage(message);
			},
			onErrorDialogOpen: () => {
				errorDialog.open();
			},
		}),
		[messageLoader, errorDialog]
	);

	// Session subscriptions hook
	const subscriptions = useSessionSubscriptions({
		sessionId,
		callbacks: subscriptionCallbacks,
	});

	// Update error details ref when error occurs
	useEffect(() => {
		if (subscriptions.state.errorDetails) {
			errorDetailsRef.current = subscriptions.state.errorDetails;
		}
	}, [subscriptions.state.errorDetails]);

	// Sync error state from subscriptions to message loader
	useEffect(() => {
		if (subscriptions.state.error) {
			messageLoader.setError(subscriptions.state.error);
		}
	}, [subscriptions.state.error, messageLoader]);

	// Send message hook
	const { sendMessage } = useSendMessage({
		sessionId,
		session: messageLoader.session,
		isSending: subscriptions.state.sending,
		onSendStart: useCallback(() => {
			messageLoader.setError(null);
		}, [messageLoader]),
		onSendComplete: useCallback(() => {
			// Completion is handled by subscriptions
		}, []),
		onError: useCallback(
			(error: string) => {
				messageLoader.setError(error);
			},
			[messageLoader]
		),
	});

	// Load session on mount
	useEffect(() => {
		subscriptions.resetState();
		messageLoader.loadSession();
	}, [sessionId]);

	// Auto-scroll hook
	const { showScrollButton, scrollToBottom } = useAutoScroll({
		containerRef: messagesContainerRef,
		endRef: messagesEndRef,
		enabled: messageLoader.autoScroll,
		messageCount: messageLoader.messages.length + subscriptions.state.streamingEvents.length,
		isInitialLoad: messageLoader.isInitialLoad,
		loadingOlder: messageLoader.loadingOlder,
	});

	// Message maps hook
	const removedOutputs = messageLoader.session?.metadata?.removedOutputs || [];
	const maps = useMessageMaps(messageLoader.messages, sessionId, removedOutputs);

	// Connection check
	const isConnected = connectionState.value === 'connected';

	// Handle send message wrapper
	const handleSendMessage = useCallback(
		async (content: string, images?: MessageImage[]) => {
			await sendMessage(content, images);
		},
		[sendMessage]
	);

	// Handle auto-scroll change
	const handleAutoScrollChange = useCallback(
		async (newAutoScroll: boolean) => {
			messageLoader.setAutoScroll(newAutoScroll);
			try {
				await updateSession(sessionId, { config: { autoScroll: newAutoScroll } });
			} catch (err) {
				messageLoader.setAutoScroll(!newAutoScroll);
				toast.error('Failed to save auto-scroll setting');
				console.error('Failed to update autoScroll:', err);
			}
		},
		[sessionId, messageLoader]
	);

	// Calculate display stats
	const displayStats = useMemo(() => {
		const accumulatedStats = messageLoader.messages.reduce(
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
				messageLoader.session?.metadata?.totalTokens ??
				accumulatedStats.inputTokens + accumulatedStats.outputTokens,
			totalCost: messageLoader.session?.metadata?.totalCost ?? accumulatedStats.totalCost,
		};
	}, [
		messageLoader.messages,
		messageLoader.session?.metadata?.totalTokens,
		messageLoader.session?.metadata?.totalCost,
	]);

	// Derived state
	const isProcessing =
		subscriptions.state.sending || subscriptions.state.streamingEvents.length > 0;
	const error = messageLoader.error || subscriptions.state.error;

	// Render loading state
	if (messageLoader.loading) {
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

	// Render error state
	if (error && !messageLoader.session) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<div class="text-5xl mb-4">⚠️</div>
					<h3 class="text-lg font-semibold text-gray-100 mb-2">Failed to load session</h3>
					<p class="text-sm text-gray-400 mb-4">{error}</p>
					<Button onClick={messageLoader.loadSession}>Retry</Button>
				</div>
			</div>
		);
	}

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden relative">
			{/* Header */}
			<ChatHeader
				session={messageLoader.session}
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
					{messageLoader.messages.length === 0 &&
					subscriptions.state.streamingEvents.length === 0 ? (
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
							{messageLoader.hasMoreMessages && messageLoader.messages.length > 0 && (
								<div class="flex items-center justify-center py-4">
									<Button
										variant="secondary"
										size="sm"
										onClick={messageLoader.loadOlderMessages}
										disabled={messageLoader.loadingOlder}
									>
										{messageLoader.loadingOlder ? (
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

							{!messageLoader.hasMoreMessages && messageLoader.messages.length > 0 && (
								<div class="flex items-center justify-center py-4">
									<div class="text-xs text-gray-500">Beginning of conversation</div>
								</div>
							)}

							{/* Messages */}
							{messageLoader.messages.map((msg, idx) => (
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
									syntheticContent={msg.uuid ? maps.compactSyntheticMap.get(msg.uuid) : undefined}
									skipSynthetic={msg.uuid ? maps.skipSyntheticSet.has(msg.uuid) : false}
								/>
							))}

							{/* Streaming */}
							{subscriptions.state.streamingEvents.length > 0 && (
								<SDKStreamingAccumulator events={subscriptions.state.streamingEvents} />
							)}
						</ContentContainer>
					)}

					<div ref={messagesEndRef} />
				</div>

				{/* Scroll Button */}
				{showScrollButton && <ScrollToBottomButton onClick={() => scrollToBottom(true)} />}
			</div>

			{/* Error Banner */}
			{error && (
				<ErrorBanner
					error={error}
					hasDetails={!!errorDetailsRef.current}
					onViewDetails={errorDialog.open}
					onDismiss={() => messageLoader.setError(null)}
				/>
			)}

			{/* Footer */}
			<div class="flex-shrink-0">
				<SessionStatusBar
					isProcessing={isProcessing}
					currentAction={subscriptions.state.currentAction}
					streamingPhase={subscriptions.state.streamingPhase}
					contextUsage={messageLoader.contextUsage}
					maxContextTokens={200000}
				/>

				{messageLoader.session?.status === 'archived' ? (
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
						disabled={isProcessing || subscriptions.state.isCompacting || !isConnected}
						autoScroll={messageLoader.autoScroll}
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
			<ToolsModal
				isOpen={toolsModal.isOpen}
				onClose={toolsModal.close}
				session={messageLoader.session}
			/>

			{/* Error Dialog */}
			<ErrorDialog
				isOpen={errorDialog.isOpen}
				onClose={errorDialog.close}
				error={errorDetailsRef.current}
				isDev={import.meta.env.DEV === 'true' || import.meta.env.MODE === 'development'}
			/>
		</div>
	);
}
