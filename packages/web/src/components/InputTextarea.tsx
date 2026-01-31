/**
 * InputTextarea Component
 *
 * iOS 26-style floating textarea input pill with auto-resize,
 * character counter, and send/stop buttons.
 * Extracted from MessageInput.tsx for better separation of concerns.
 *
 * CURSOR PRESERVATION FIX:
 * This component uses an "uncontrolled with sync" pattern instead of the
 * standard controlled input pattern (`value={content}`). This is intentional.
 *
 * PROBLEM: Controlled inputs cause cursor position reset on every re-render.
 * When any prop changes (isAgentWorking, etc.) or when the parent re-renders,
 * Preact sets textarea.value = content. Even if the DOM already has the correct
 * value, setting element.value programmatically resets cursor position.
 *
 * SYMPTOMS:
 * - Lost keystrokes when typing fast
 * - Arrow keys "stop working" after a few presses (cursor keeps resetting)
 *
 * SOLUTION: Use useLayoutEffect to sync content to DOM only when they differ.
 * After user types, DOM already has the new value (browser updated it).
 * Our onInput updates the signal to match. On re-render, DOM === content,
 * so we skip the DOM write and cursor position is preserved.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../lib/utils.ts';
import { borderColors } from '../lib/design-tokens.ts';
import CommandAutocomplete from './CommandAutocomplete.tsx';

export interface InputTextareaProps {
	content: string;
	onContentChange: (content: string) => void;
	onKeyDown: (e: KeyboardEvent) => void;
	onSubmit: () => void;
	disabled?: boolean;
	maxChars?: number;
	// Command autocomplete
	showCommandAutocomplete?: boolean;
	filteredCommands?: string[];
	selectedCommandIndex?: number;
	onCommandSelect?: (command: string) => void;
	onCommandClose?: () => void;
	// Agent state - passed as prop to avoid direct signal reads that cause re-renders
	isAgentWorking?: boolean;
	// Interrupt
	interrupting?: boolean;
	onInterrupt?: () => void;
}

/**
 * Floating textarea input with send/stop buttons
 */
export function InputTextarea({
	content,
	onContentChange,
	onKeyDown,
	onSubmit,
	disabled,
	maxChars = 10000,
	showCommandAutocomplete = false,
	filteredCommands = [],
	selectedCommandIndex = 0,
	onCommandSelect,
	onCommandClose,
	isAgentWorking = false,
	interrupting = false,
	onInterrupt,
}: InputTextareaProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [isMultiline, setIsMultiline] = useState(false);

	// Detect if device is mobile (touch-based)
	const isMobileDevice = useRef(false);

	// Detect mobile device on mount
	useEffect(() => {
		const isTouchDevice =
			window.matchMedia('(pointer: coarse)').matches ||
			('ontouchstart' in window && window.innerWidth < 768);
		isMobileDevice.current = isTouchDevice;
	}, []);

	// Sync content prop to textarea DOM only when they differ
	// This prevents cursor position reset during re-renders caused by signal changes
	// or other prop updates. Using useLayoutEffect for synchronous DOM updates.
	//
	// KEY INSIGHT: When user types, the browser updates DOM value immediately.
	// Our onInput handler then updates the signal/state to match DOM.
	// On the next render, content === textarea.value, so we skip the DOM write.
	// This preserves cursor position because we never programmatically set value
	// when it already matches.
	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;

		// Only update DOM if the value actually differs
		if (textarea.value !== content) {
			// Save cursor position before updating
			const { selectionStart, selectionEnd } = textarea;

			// Update value
			textarea.value = content;

			// Restore cursor position (clamped to valid range)
			// This handles external content changes (e.g., loading draft, clearing)
			const maxPos = content.length;
			textarea.setSelectionRange(Math.min(selectionStart, maxPos), Math.min(selectionEnd, maxPos));
		}
	}, [content]);

	// Auto-resize textarea
	useEffect(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			textarea.style.height = '40px';
			const newHeight = Math.min(Math.max(40, textarea.scrollHeight), 200);
			textarea.style.height = `${newHeight}px`;
			setIsMultiline(newHeight > 45);
		}
	}, [content]);

	// Focus on mount
	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const charCount = content.length;
	const showCharCount = charCount > maxChars * 0.8;
	const hasContent = content.trim().length > 0;

	return (
		<div class="relative flex-1">
			{/* Command Autocomplete */}
			{showCommandAutocomplete && onCommandSelect && onCommandClose && (
				<CommandAutocomplete
					commands={filteredCommands}
					selectedIndex={selectedCommandIndex}
					onSelect={onCommandSelect}
					onClose={onCommandClose}
				/>
			)}

			<div
				class={cn(
					'relative rounded-3xl border transition-all',
					'bg-dark-800/60 backdrop-blur-sm',
					disabled
						? borderColors.ui.disabled
						: `${borderColors.ui.input} focus-within:bg-dark-800/80`
				)}
			>
				{/* Textarea - Uncontrolled with sync pattern
				    We DON'T use value={content} here because controlled inputs cause
				    cursor position reset on every re-render. Instead, we sync content
				    to the DOM via useLayoutEffect only when they actually differ.
				    See the useLayoutEffect above for details. */}
				<textarea
					ref={textareaRef}
					onInput={(e) => onContentChange((e.target as HTMLTextAreaElement).value)}
					onKeyDown={onKeyDown}
					placeholder="Ask or make anything..."
					maxLength={maxChars}
					rows={1}
					class={cn(
						'block w-full pl-5 pr-14 py-2.5 text-gray-100 resize-none bg-transparent',
						'placeholder:text-gray-500 text-base leading-normal',
						'focus:outline-none'
					)}
					style={{
						height: '40px',
						maxHeight: '200px',
					}}
				/>

				{/* Character Counter */}
				{showCharCount && (
					<div
						class={cn(
							'absolute top-1 right-14 text-xs',
							charCount >= maxChars ? 'text-red-400' : 'text-gray-500'
						)}
					>
						{charCount}/{maxChars}
					</div>
				)}

				{/* Send/Stop Button */}
				{isAgentWorking || interrupting ? (
					<button
						type="button"
						onClick={onInterrupt}
						disabled={interrupting}
						title="Stop generation (Escape)"
						aria-label="Stop generation"
						data-testid="stop-button"
						class={cn(
							'absolute right-1.5',
							isMultiline ? 'bottom-1.5' : 'top-1/2 -translate-y-1/2',
							'w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200',
							interrupting
								? 'bg-dark-700/50 text-gray-500 cursor-not-allowed'
								: 'bg-red-500 text-white hover:bg-red-600 active:scale-95'
						)}
					>
						{interrupting ? (
							<div class="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
						) : (
							<svg class="w-4.5 h-4.5" fill="currentColor" viewBox="0 0 24 24">
								<rect x="5" y="5" width="14" height="14" rx="1.5" />
							</svg>
						)}
					</button>
				) : (
					<button
						type="button"
						onClick={onSubmit}
						disabled={isAgentWorking || !hasContent}
						title={isMobileDevice.current ? 'Send message' : 'Send message (Enter or Cmd+Enter)'}
						aria-label="Send message"
						data-testid="send-button"
						class={cn(
							'absolute right-1.5',
							isMultiline ? 'bottom-1.5' : 'top-1/2 -translate-y-1/2',
							'w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200',
							hasContent && !disabled
								? 'bg-blue-500 text-white hover:bg-blue-600 active:scale-95'
								: 'bg-dark-700/50 text-gray-500 cursor-not-allowed'
						)}
					>
						<svg
							class="w-4.5 h-4.5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width={2.5}
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
						</svg>
					</button>
				)}
			</div>
		</div>
	);
}
