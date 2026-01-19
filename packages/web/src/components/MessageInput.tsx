/**
 * MessageInput Component
 *
 * iOS 26-style floating message input with auto-resize textarea,
 * command autocomplete, file attachments, and action menu.
 *
 * Refactored to use shared hooks for better separation of concerns.
 */

import { useCallback, useState } from 'preact/hooks';
import type { MessageImage } from '@liuboer/shared';
import { isAgentWorking } from '../lib/state.ts';
import { AttachmentPreview } from './AttachmentPreview.tsx';
import { InputActionsMenu } from './InputActionsMenu.tsx';
import { InputTextarea } from './InputTextarea.tsx';
import { ContentContainer } from './ui/ContentContainer.tsx';
import {
	useInputDraft,
	useModelSwitcher,
	useModal,
	useCommandAutocomplete,
	useInterrupt,
	useFileAttachments,
} from '../hooks';

interface MessageInputProps {
	sessionId: string;
	onSend: (content: string, images?: MessageImage[]) => void;
	disabled?: boolean;
	autoScroll?: boolean;
	onAutoScrollChange?: (autoScroll: boolean) => void;
	onOpenTools?: () => void;
}

export default function MessageInput({
	sessionId,
	onSend,
	disabled,
	autoScroll,
	onAutoScrollChange,
	onOpenTools,
}: MessageInputProps) {
	// Drag and drop state
	const [isDragging, setIsDragging] = useState(false);

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
	const { interrupting, handleInterrupt } = useInterrupt({ sessionId });
	const {
		attachments,
		fileInputRef,
		handleFileSelect,
		handleFileDrop,
		handleRemove,
		clear: clearAttachments,
		openFilePicker,
		getImagesForSend,
	} = useFileAttachments();

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

	// Submit handler
	const handleSubmit = useCallback(() => {
		const messageContent = content.trim();
		if (!messageContent || isAgentWorking.value) {
			return;
		}

		// Get images for sending
		const images = getImagesForSend();

		// Clear UI
		clearDraft();
		clearAttachments();

		// Send message with images
		onSend(messageContent, images);
	}, [content, clearDraft, clearAttachments, onSend, getImagesForSend]);

	// Keyboard handler
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			// Try command autocomplete first
			if (commandAutocomplete.handleKeyDown(e)) {
				return;
			}

			// Handle Enter key behavior
			if (e.key === 'Enter') {
				if (e.metaKey || e.ctrlKey) {
					e.preventDefault();
					handleSubmit();
					return;
				}

				// Desktop: Enter submits, Shift+Enter for newline
				const isTouchDevice =
					window.matchMedia('(pointer: coarse)').matches ||
					('ontouchstart' in window && window.innerWidth < 768);

				if (!isTouchDevice && !e.shiftKey) {
					e.preventDefault();
					handleSubmit();
				}
			} else if (e.key === 'Escape') {
				// Escape interrupts the agent if it's working
				// Note: Escape does NOT clear the input when idle - that would be unexpected UX
				if (isAgentWorking.value && !interrupting) {
					e.preventDefault();
					handleInterrupt();
				}
			}
		},
		[commandAutocomplete, handleSubmit, interrupting, handleInterrupt]
	);

	// Model switch handler
	const handleModelSwitch = useCallback(
		async (modelId: string) => {
			await switchModel(modelId);
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
						handleSubmit();
					}}
				>
					{/* Attachment Preview */}
					{attachments.length > 0 && (
						<div class="mb-3">
							<AttachmentPreview attachments={attachments} onRemove={handleRemove} />
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
							onSubmit={handleSubmit}
							disabled={disabled}
							showCommandAutocomplete={commandAutocomplete.showAutocomplete}
							filteredCommands={commandAutocomplete.filteredCommands}
							selectedCommandIndex={commandAutocomplete.selectedIndex}
							onCommandSelect={commandAutocomplete.handleSelect}
							onCommandClose={commandAutocomplete.close}
							isAgentWorking={isAgentWorking.value}
							interrupting={interrupting}
							onInterrupt={handleInterrupt}
						/>
					</div>
				</form>
			</div>
		</ContentContainer>
	);
}
