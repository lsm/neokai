/**
 * MessageInput Component
 *
 * iOS 26-style floating message input with auto-resize textarea,
 * command autocomplete, file attachments, and action menu.
 *
 * Refactored to use shared hooks for better separation of concerns.
 */

import { useCallback } from 'preact/hooks';
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
				if (isAgentWorking.value && !interrupting) {
					e.preventDefault();
					handleInterrupt();
				} else if (!isAgentWorking.value) {
					clearDraft();
				}
			}
		},
		[commandAutocomplete, handleSubmit, interrupting, handleInterrupt, clearDraft]
	);

	// Model switch handler
	const handleModelSwitch = useCallback(
		async (modelId: string) => {
			await switchModel(modelId);
			actionsMenu.close();
		},
		[switchModel, actionsMenu]
	);

	return (
		<ContentContainer className="py-4">
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
						interrupting={interrupting}
						onInterrupt={handleInterrupt}
					/>
				</div>
			</form>
		</ContentContainer>
	);
}
