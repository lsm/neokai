/**
 * MessageInput Component
 *
 * iOS 26-style floating message input with auto-resize textarea,
 * command autocomplete, file attachments, and action menu.
 *
 * Refactored to use shared hooks for better separation of concerns.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type {
	MessageDeliveryMode,
	MessageImage,
	ModelInfo,
	ReferenceMention,
	SessionType,
} from '@neokai/shared';
import { isAgentWorking } from '../lib/state.ts';
import { connectionManager } from '../lib/connection-manager';
import { getMessagesBottomPaddingPx } from '../lib/layout-metrics.ts';
import { AttachmentPreview } from './AttachmentPreview.tsx';
import { InputActionsMenu } from './InputActionsMenu.tsx';
import { InputTextarea } from './InputTextarea.tsx';
import { ContentContainer } from './ui/ContentContainer.tsx';
import {
	useInputDraft,
	useModelSwitcher,
	useModal,
	useCommandAutocomplete,
	useReferenceAutocomplete,
	useFileAttachments,
	useInterrupt,
} from '../hooks';

/**
 * Replace the active @query at the end of `content` with a formatted reference token.
 *
 * Scans for the last word-boundary `@\S*` at the end of the string (matching
 * the same logic as `extractActiveAtQuery` in `useReferenceAutocomplete`), then
 * replaces it with `@ref{type:id} ` (trailing space prevents re-triggering).
 *
 * Returns the updated content, or the original string if no active @query is found.
 */
export function replaceActiveAtQuery(content: string, type: string, id: string): string {
	const replacement = `@ref{${type}:${id}} `;
	// Match the last word-boundary @ and the non-whitespace characters following it.
	// Group 1 captures the leading whitespace (or empty string at start) so we can
	// preserve it in the replacement.
	const match = content.match(/((?:^|\s))@(\S*)$/);
	if (!match) return content;
	const prefix = match[1];
	const matchStart = content.length - match[0].length;
	return content.slice(0, matchStart) + prefix + replacement;
}

function getPlaceholderForSessionType(sessionType?: SessionType): string {
	switch (sessionType) {
		case 'room_chat':
			return 'Chat with the room coordinator...';
		case 'worker':
		default:
			return 'Ask or make anything...';
	}
}

interface MessageInputProps {
	sessionId: string;
	sessionType?: SessionType;
	onSend: (
		content: string,
		images?: MessageImage[],
		deliveryMode?: MessageDeliveryMode
	) => Promise<void>;
	disabled?: boolean;
	autoScroll?: boolean;
	onAutoScrollChange?: (autoScroll: boolean) => void;
	onOpenTools?: () => void;
	onEnterRewindMode?: () => void;
	rewindMode?: boolean;
	onExitRewindMode?: () => void;
}

interface QueuedOverlayMessage {
	dbId: string;
	uuid: string;
	text: string;
	timestamp: number;
	status: 'deferred' | 'enqueued' | 'consumed';
}

export default function MessageInput({
	sessionId,
	sessionType,
	onSend,
	disabled,
	autoScroll,
	onAutoScrollChange,
	onOpenTools,
	onEnterRewindMode,
	rewindMode,
	onExitRewindMode,
}: MessageInputProps) {
	// Cache touch device detection — computed once on first render, stable thereafter.
	// Using useRef (not a module constant) so tests can mock matchMedia before render.
	const isTouchDeviceRef = useRef(
		window.matchMedia('(pointer: coarse)').matches ||
			('ontouchstart' in window && window.innerWidth < 768)
	);

	// Drag and drop state
	const [isDragging, setIsDragging] = useState(false);

	// Textarea ref for programmatic focus after reference selection
	const textareaInputRef = useRef<HTMLTextAreaElement>(null);

	// Use shared hooks
	const { content, setContent, clear: clearDraft } = useInputDraft(sessionId);
	const {
		currentModel,
		currentModelInfo,
		availableModels,
		switching: modelSwitching,
		loading: modelLoading,
		switchModel,
	} = useModelSwitcher(sessionId);
	const actionsMenu = useModal();
	const {
		attachments,
		fileInputRef,
		handleFileSelect,
		handleFileDrop,
		handleRemove,
		clear: clearAttachments,
		openFilePicker,
		getImagesForSend,
		handlePaste,
	} = useFileAttachments();
	const { handleInterrupt } = useInterrupt({ sessionId });

	// Command autocomplete
	const handleCommandSelect = useCallback(
		(command: string) => {
			setContent('/' + command + ' ');
		},
		[setContent]
	);

	const commandAutocomplete = useCommandAutocomplete({
		content,
		onSelect: handleCommandSelect,
	});

	// Reference autocomplete
	const handleReferenceSelect = useCallback(
		(reference: ReferenceMention) => {
			const updated = replaceActiveAtQuery(content, reference.type, reference.id);
			// No active @query — nothing to replace; skip the setContent call to avoid spurious re-renders
			if (updated === content) return;
			setContent(updated);
			// Restore focus to textarea after selection
			textareaInputRef.current?.focus();
		},
		[content, setContent]
	);

	const referenceAutocomplete = useReferenceAutocomplete({
		content,
		onSelect: handleReferenceSelect,
	});
	const agentWorking = isAgentWorking.value;
	const [queuedForCurrentTurn, setQueuedForCurrentTurn] = useState<QueuedOverlayMessage[]>([]);
	const [queuedForNextTurn, setQueuedForNextTurn] = useState<QueuedOverlayMessage[]>([]);

	const syncMessagesContainerPadding = useCallback(() => {
		const scroller = document.querySelector<HTMLElement>('[data-messages-container]');
		const footer = document.querySelector<HTMLElement>('.chat-footer');
		if (!scroller || !footer) return;

		const footerHeightPx = Math.max(footer.getBoundingClientRect().height, footer.scrollHeight);
		const nextPaddingPx = getMessagesBottomPaddingPx(footerHeightPx);
		const nextPaddingValue = `${nextPaddingPx}px`;
		const currentPaddingVar = scroller.style.getPropertyValue('--messages-bottom-padding').trim();
		if (currentPaddingVar !== nextPaddingValue) {
			scroller.style.setProperty('--messages-bottom-padding', nextPaddingValue);
		}
	}, []);

	const extractOutgoingMessage = useCallback(() => {
		const messageContent = content.trim();
		if (!messageContent) {
			return null;
		}
		return {
			content: messageContent,
			images: getImagesForSend(),
		};
	}, [content, getImagesForSend]);

	const refreshQueuedMessages = useCallback(async () => {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			return;
		}

		try {
			const [enqueuedResponse, deferredResponse] = (await Promise.all([
				hub.request('session.messages.byStatus', {
					sessionId,
					status: 'enqueued',
					limit: 20,
				}),
				hub.request('session.messages.byStatus', {
					sessionId,
					status: 'deferred',
					limit: 20,
				}),
			])) as [{ messages?: QueuedOverlayMessage[] }, { messages?: QueuedOverlayMessage[] }];
			setQueuedForCurrentTurn(enqueuedResponse.messages ?? []);
			setQueuedForNextTurn(deferredResponse.messages ?? []);
		} catch {
			// Best-effort queue refresh
		}
	}, [sessionId]);

	useEffect(() => {
		void refreshQueuedMessages();
	}, [refreshQueuedMessages]);

	useEffect(() => {
		syncMessagesContainerPadding();
	}, [syncMessagesContainerPadding]);

	useEffect(() => {
		if (!agentWorking && queuedForCurrentTurn.length === 0 && queuedForNextTurn.length === 0)
			return;
		const timer = setInterval(() => {
			void refreshQueuedMessages();
		}, 700);
		return () => clearInterval(timer);
	}, [agentWorking, queuedForCurrentTurn.length, queuedForNextTurn.length, refreshQueuedMessages]);

	useEffect(() => {
		syncMessagesContainerPadding();
	}, [
		syncMessagesContainerPadding,
		attachments.length,
		isDragging,
		queuedForCurrentTurn.length,
		queuedForNextTurn.length,
	]);

	const handleTextareaHeightChange = useCallback(
		(_heightPx: number) => {
			syncMessagesContainerPadding();
		},
		[syncMessagesContainerPadding]
	);

	// Submit handler
	const handleSubmit = useCallback(
		async (deliveryMode: MessageDeliveryMode = 'immediate') => {
			if (disabled) {
				return;
			}
			const outgoing = extractOutgoingMessage();
			if (!outgoing) return;

			// Clear UI
			clearDraft();
			clearAttachments();

			// Send message with images
			await onSend(outgoing.content, outgoing.images, deliveryMode);
			if (
				agentWorking ||
				deliveryMode === 'defer' ||
				queuedForCurrentTurn.length > 0 ||
				queuedForNextTurn.length > 0
			) {
				await refreshQueuedMessages();
			}
		},
		[
			disabled,
			extractOutgoingMessage,
			clearDraft,
			clearAttachments,
			onSend,
			agentWorking,
			queuedForCurrentTurn.length,
			queuedForNextTurn.length,
			refreshQueuedMessages,
		]
	);

	// Destructure stable callback refs to avoid recreating handleKeyDown on every render
	// (hooks return new object instances each render, but the functions inside are stable
	// via useCallback, so depending on the functions directly is more efficient)
	const refHandleKeyDown = referenceAutocomplete.handleKeyDown;
	const cmdHandleKeyDown = commandAutocomplete.handleKeyDown;

	// Keyboard handler
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			// Reference autocomplete takes precedence when visible
			if (refHandleKeyDown(e)) {
				return;
			}

			// Then try command autocomplete
			if (cmdHandleKeyDown(e)) {
				return;
			}

			if (e.key === 'Tab' && !e.shiftKey && agentWorking) {
				e.preventDefault();
				void handleSubmit('defer');
				return;
			}

			// Handle Enter key behavior
			if (e.key === 'Enter') {
				if (e.metaKey || e.ctrlKey) {
					e.preventDefault();
					void handleSubmit('immediate');
					return;
				}

				// Desktop: Enter submits, Shift+Enter for newline
				if (!isTouchDeviceRef.current && !e.shiftKey) {
					e.preventDefault();
					void handleSubmit('immediate');
				}
			}
		},
		[refHandleKeyDown, cmdHandleKeyDown, handleSubmit, agentWorking]
	);

	// Model switch handler
	const handleModelSwitch = useCallback(
		async (model: ModelInfo) => {
			await switchModel(model);
			actionsMenu.close();
		},
		[switchModel, actionsMenu]
	);

	// Drag and drop handlers
	const handleDragEnter = useCallback(
		(e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (disabled || !e.dataTransfer?.types.includes('Files')) return;
			setIsDragging(true);
		},
		[disabled]
	);

	const handleDragOver = useCallback(
		(e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (disabled) return;
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'copy';
			}
		},
		[disabled]
	);

	const handleDragLeave = useCallback((e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Only hide overlay when leaving the drop zone entirely
		if (e.currentTarget === e.target) {
			setIsDragging(false);
		}
	}, []);

	const handleDrop = useCallback(
		async (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragging(false);

			if (disabled || !e.dataTransfer?.files) return;

			const files = e.dataTransfer.files;
			if (files.length > 0) {
				await handleFileDrop(files);
			}
		},
		[disabled, handleFileDrop]
	);

	return (
		<ContentContainer className="pb-2">
			<div
				class="relative"
				onDragEnter={handleDragEnter}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				{/* Drag Overlay */}
				{isDragging && (
					<div class="absolute inset-0 z-50 flex items-center justify-center bg-dark-900/90 backdrop-blur-sm border-2 border-dashed border-blue-500 rounded-2xl pointer-events-none">
						<div class="text-center">
							<svg
								class="w-16 h-16 mx-auto mb-4 text-blue-400"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
								/>
							</svg>
							<p class="text-lg font-medium text-white">Drop images here</p>
							<p class="text-sm text-gray-400 mt-1">PNG, JPG, GIF, or WebP</p>
						</div>
					</div>
				)}

				<form
					onSubmit={(e) => {
						e.preventDefault();
						void handleSubmit('immediate');
					}}
				>
					{/* Attachment Preview */}
					{attachments.length > 0 && (
						<div class="mb-3">
							<AttachmentPreview attachments={attachments} onRemove={handleRemove} />
						</div>
					)}

					{(queuedForCurrentTurn.length > 0 || queuedForNextTurn.length > 0) && !disabled && (
						<div class="mb-2 flex flex-col items-end gap-1.5" data-testid="queue-overlay">
							{queuedForCurrentTurn.slice(0, 3).map((queued, index) => (
								<div
									key={queued.dbId}
									class="pointer-events-none inline-flex max-w-[22rem] items-center gap-2 rounded-full border border-dark-600/80 bg-dark-900/85 px-3 py-1 text-xs text-gray-200 backdrop-blur-sm"
									data-testid="queued-current-turn-bubble"
								>
									<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
									<span class="truncate">
										{index === 0 && <span class="mr-1 text-amber-300">Now</span>}
										{queued.text}
									</span>
								</div>
							))}
							{queuedForNextTurn.slice(0, 3).map((queued, index) => (
								<div
									key={queued.dbId}
									class="pointer-events-none inline-flex max-w-[22rem] items-center gap-2 rounded-full border border-dark-600/80 bg-dark-900/85 px-3 py-1 text-xs text-gray-200 backdrop-blur-sm"
									data-testid="queued-next-turn-bubble"
								>
									<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
									<span class="truncate">
										{index === 0 && <span class="mr-1 text-blue-300">Next</span>}
										{queued.text}
									</span>
								</div>
							))}
							{queuedForCurrentTurn.length > 3 && (
								<p class="pointer-events-none text-xs text-amber-200/80">
									+{queuedForCurrentTurn.length - 3} more pending
								</p>
							)}
							{queuedForNextTurn.length > 3 && (
								<p class="pointer-events-none text-xs text-blue-200/80">
									+{queuedForNextTurn.length - 3} more deferred
								</p>
							)}
						</div>
					)}

					{/* iOS 26 Style: Floating single-line input */}
					<div class="flex items-end gap-3">
						{/* Plus Button with Actions Menu */}
						<InputActionsMenu
							isOpen={actionsMenu.isOpen}
							onToggle={actionsMenu.toggle}
							onClose={actionsMenu.close}
							currentModel={currentModel}
							currentModelInfo={currentModelInfo}
							availableModels={availableModels}
							modelSwitching={modelSwitching}
							modelLoading={modelLoading}
							onModelSwitch={handleModelSwitch}
							autoScroll={autoScroll ?? true}
							onAutoScrollChange={(enabled) => onAutoScrollChange?.(enabled)}
							onOpenTools={() => onOpenTools?.()}
							onAttachFile={openFilePicker}
							onEnterRewindMode={onEnterRewindMode}
							rewindMode={rewindMode}
							onExitRewindMode={onExitRewindMode}
							disabled={disabled}
						/>

						{/* Hidden file input */}
						<input
							ref={fileInputRef}
							type="file"
							accept="image/png,image/jpeg,image/gif,image/webp"
							multiple
							onChange={handleFileSelect}
							class="hidden"
						/>

						{/* Input Textarea */}
						<InputTextarea
							content={content}
							onContentChange={setContent}
							onKeyDown={handleKeyDown}
							onSubmit={() => {
								void handleSubmit('immediate');
							}}
							disabled={disabled}
							placeholder={getPlaceholderForSessionType(sessionType)}
							showCommandAutocomplete={
								commandAutocomplete.showAutocomplete && !referenceAutocomplete.showAutocomplete
							}
							filteredCommands={commandAutocomplete.filteredCommands}
							selectedCommandIndex={commandAutocomplete.selectedIndex}
							onCommandSelect={commandAutocomplete.handleSelect}
							onCommandClose={commandAutocomplete.close}
							showReferenceAutocomplete={referenceAutocomplete.showAutocomplete}
							referenceResults={referenceAutocomplete.results}
							selectedReferenceIndex={referenceAutocomplete.selectedIndex}
							onReferenceSelect={referenceAutocomplete.handleSelect}
							onReferenceClose={referenceAutocomplete.close}
							isAgentWorking={agentWorking}
							onStop={handleInterrupt}
							onPaste={disabled ? undefined : handlePaste}
							textareaRef={textareaInputRef}
							transparent={true}
							onHeightChange={handleTextareaHeightChange}
						/>
					</div>
				</form>
			</div>
		</ContentContainer>
	);
}
