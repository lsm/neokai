/**
 * MessageInput Component
 *
 * iOS 26-style floating message input with auto-resize textarea,
 * command autocomplete, file attachments, and action menu.
 *
 * Refactored to use shared hooks for better separation of concerns.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
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
			return 'Ask or make anything...';
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
	) => Promise<void | boolean>;
	disabled?: boolean;
	autoScroll?: boolean;
	onAutoScrollChange?: (autoScroll: boolean) => void;
	onOpenTools?: () => void;
	onEnterRewindMode?: () => void;
	rewindMode?: boolean;
	onExitRewindMode?: () => void;
	agentMentionCandidates?: Array<{ id: string; name: string }>;
	/** Override the default placeholder derived from sessionType */
	placeholder?: string;
	/** Optional control rendered inside the input, on the left side */
	leadingElement?: ComponentChildren;
	/** Left padding class used when leadingElement is present */
	leadingPaddingClass?: string;
	/** Emits whether the current draft has non-whitespace content */
	onDraftActiveChange?: (hasDraft: boolean) => void;
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
	agentMentionCandidates,
	placeholder: placeholderProp,
	leadingElement,
	leadingPaddingClass,
	onDraftActiveChange,
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

	useEffect(() => {
		onDraftActiveChange?.(content.trim().length > 0);
	}, [content, onDraftActiveChange]);

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

	// Agent mention autocomplete (for workflow agent @-mentions)
	const [agentMentionQuery, setAgentMentionQuery] = useState<string | null>(null);
	const [agentMentionSelectedIndex, setAgentMentionSelectedIndex] = useState(0);
	const lastCursorRef = useRef(0);

	const filteredAgentMentionCandidates = useMemo(() => {
		if (agentMentionQuery === null || !agentMentionCandidates) return [];
		return agentMentionCandidates.filter((a) =>
			a.name.toLowerCase().startsWith(agentMentionQuery.toLowerCase())
		);
	}, [agentMentionCandidates, agentMentionQuery]);

	const showAgentMentionAutocomplete =
		agentMentionQuery !== null && filteredAgentMentionCandidates.length > 0;

	// Wrap setContent to detect @-mentions
	const handleContentChange = useCallback(
		(value: string) => {
			// Track cursor position via the textarea ref
			const cursor = textareaInputRef.current?.selectionStart ?? value.length;
			lastCursorRef.current = cursor;
			setContent(value);

			if (agentMentionCandidates && agentMentionCandidates.length > 0) {
				const textBeforeCursor = value.slice(0, cursor);
				const match = textBeforeCursor.match(/@(\w*)$/);
				if (match) {
					setAgentMentionQuery(match[1]);
					setAgentMentionSelectedIndex(0);
				} else {
					setAgentMentionQuery(null);
				}
			}
		},
		[setContent, agentMentionCandidates]
	);

	const handleAgentMentionSelect = useCallback(
		(name: string) => {
			const cursor = textareaInputRef.current?.selectionStart ?? lastCursorRef.current;
			const textBeforeCursor = content.slice(0, cursor);
			const textAfterCursor = content.slice(cursor);
			const match = textBeforeCursor.match(/@(\w*)$/);
			if (!match) return;
			const start = cursor - match[0].length;
			const newValue = content.slice(0, start) + '@' + name + ' ' + textAfterCursor;
			setContent(newValue);
			setAgentMentionQuery(null);
			setAgentMentionSelectedIndex(0);
			setTimeout(() => {
				if (textareaInputRef.current) {
					const newCursor = start + name.length + 2;
					textareaInputRef.current.focus();
					textareaInputRef.current.setSelectionRange(newCursor, newCursor);
				}
			}, 0);
		},
		[content, setContent]
	);

	const handleAgentMentionClose = useCallback(() => {
		setAgentMentionQuery(null);
		setAgentMentionSelectedIndex(0);
	}, []);

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

			// Save content before clearing so we can restore it if the send fails.
			const savedContent = outgoing.content;

			// Clear UI optimistically
			clearDraft();
			clearAttachments();

			// Send message with images; a boolean false return signals failure
			const result = await onSend(savedContent, outgoing.images, deliveryMode);
			if (result === false) {
				// Restore the draft so the user doesn't lose their message
				setContent(savedContent);
				return;
			}
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
			setContent,
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
			// Agent mention autocomplete takes highest precedence when visible
			if (showAgentMentionAutocomplete) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					setAgentMentionSelectedIndex((i) =>
						Math.min(i + 1, filteredAgentMentionCandidates.length - 1)
					);
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					setAgentMentionSelectedIndex((i) => Math.max(i - 1, 0));
					return;
				}
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					const candidate = filteredAgentMentionCandidates[agentMentionSelectedIndex];
					if (candidate) {
						handleAgentMentionSelect(candidate.name);
					}
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					handleAgentMentionClose();
					return;
				}
			}

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
		[
			refHandleKeyDown,
			cmdHandleKeyDown,
			handleSubmit,
			agentWorking,
			showAgentMentionAutocomplete,
			filteredAgentMentionCandidates,
			agentMentionSelectedIndex,
			handleAgentMentionSelect,
			handleAgentMentionClose,
		]
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
							onContentChange={handleContentChange}
							onKeyDown={handleKeyDown}
							onSubmit={() => {
								void handleSubmit('immediate');
							}}
							disabled={disabled}
							placeholder={placeholderProp ?? getPlaceholderForSessionType(sessionType)}
							showAgentMentionAutocomplete={showAgentMentionAutocomplete}
							agentMentionCandidates={filteredAgentMentionCandidates}
							selectedAgentMentionIndex={agentMentionSelectedIndex}
							onAgentMentionSelect={handleAgentMentionSelect}
							onAgentMentionClose={handleAgentMentionClose}
							showCommandAutocomplete={
								!showAgentMentionAutocomplete &&
								commandAutocomplete.showAutocomplete &&
								!referenceAutocomplete.showAutocomplete
							}
							filteredCommands={commandAutocomplete.filteredCommands}
							selectedCommandIndex={commandAutocomplete.selectedIndex}
							onCommandSelect={commandAutocomplete.handleSelect}
							onCommandClose={commandAutocomplete.close}
							showReferenceAutocomplete={
								!showAgentMentionAutocomplete && referenceAutocomplete.showAutocomplete
							}
							referenceResults={referenceAutocomplete.results}
							selectedReferenceIndex={referenceAutocomplete.selectedIndex}
							onReferenceSelect={referenceAutocomplete.handleSelect}
							onReferenceClose={referenceAutocomplete.close}
							isAgentWorking={agentWorking}
							onStop={handleInterrupt}
							onPaste={disabled ? undefined : handlePaste}
							textareaRef={textareaInputRef}
							transparent={true}
							leadingElement={leadingElement}
							leadingPaddingClass={leadingPaddingClass}
							onHeightChange={handleTextareaHeightChange}
						/>
					</div>
				</form>
			</div>
		</ContentContainer>
	);
}
