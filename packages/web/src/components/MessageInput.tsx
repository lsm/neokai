import { useEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../lib/utils.ts';
import { slashCommandsSignal } from '../lib/signals.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import CommandAutocomplete from './CommandAutocomplete.tsx';
import type { ModelInfo } from '@liuboer/shared';
import { isAgentWorking } from '../lib/state.ts';

interface MessageInputProps {
	sessionId: string;
	onSend: (content: string) => void;
	disabled?: boolean;
	autoScroll?: boolean;
	onAutoScrollChange?: (autoScroll: boolean) => void;
}

/**
 * Model family icons for visual hierarchy
 */
const MODEL_FAMILY_ICONS = {
	opus: '🧠',
	sonnet: '💎',
	haiku: '⚡',
} as const;

export default function MessageInput({
	sessionId,
	onSend,
	disabled,
	autoScroll,
	onAutoScrollChange,
}: MessageInputProps) {
	const [content, setContent] = useState('');
	const [showCommandAutocomplete, setShowCommandAutocomplete] = useState(false);
	const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
	const [filteredCommands, setFilteredCommands] = useState<string[]>([]);
	const [menuOpen, setMenuOpen] = useState(false);
	const [showModelSubmenu, setShowModelSubmenu] = useState(false);

	// Model state
	const [currentModel, setCurrentModel] = useState<string>('');
	const [currentModelInfo, setCurrentModelInfo] = useState<ModelInfo | null>(null);
	const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
	const [switching, setSwitching] = useState(false);
	const [loadingModels, setLoadingModels] = useState(true);

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const plusButtonRef = useRef<HTMLButtonElement>(null);
	const maxChars = 10000;

	// Track interrupting state
	const [interrupting, setInterrupting] = useState(false);

	// Track multiline state for button positioning
	const [isMultiline, setIsMultiline] = useState(false);

	// Draft persistence timeout ref
	const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Detect if device is mobile (touch-based)
	const isMobileDevice = useRef(false);

	// Detect mobile device on mount
	useEffect(() => {
		// Check if primary input is touch (mobile) or fine pointer (desktop)
		const isTouchDevice =
			window.matchMedia('(pointer: coarse)').matches ||
			('ontouchstart' in window && window.innerWidth < 768);
		isMobileDevice.current = isTouchDevice;
	}, []);

	// Auto-resize textarea - starts at 40px (h-10), expands up to 200px
	useEffect(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			// Reset to min height to measure actual content
			textarea.style.height = '40px';
			// Expand if content needs more space (max 200px)
			const newHeight = Math.min(Math.max(40, textarea.scrollHeight), 200);
			textarea.style.height = `${newHeight}px`;
			// Track multiline state for button positioning (use threshold of 45px to account for slight variations)
			setIsMultiline(newHeight > 45);
		}
	}, [content]);

	// Focus on mount and reset interrupting state on session change
	useEffect(() => {
		textareaRef.current?.focus();
		// Reset interrupting state when switching sessions
		setInterrupting(false);
	}, [sessionId]);

	// Load draft from session metadata on mount/session change
	useEffect(() => {
		// Clear content immediately if sessionId is invalid
		if (!sessionId) {
			setContent('');
			return;
		}

		// Clear content immediately when sessionId changes to prevent showing stale draft
		setContent('');

		const loadDraft = async () => {
			try {
				const hub = await connectionManager.getHub();
				const response = await hub.call<{ session: { metadata?: { inputDraft?: string } } }>(
					'session.get',
					{ sessionId }
				);
				const draft = response.session?.metadata?.inputDraft;
				if (draft) {
					setContent(draft);
				}
			} catch (error) {
				console.error('Failed to load draft:', error);
			}
		};

		loadDraft();
	}, [sessionId]);

	// Track previous sessionId for cleanup
	const prevSessionIdRef = useRef<string | null>(null);

	// Save draft to session metadata (debounced 250ms for non-empty, immediate for empty)
	useEffect(() => {
		// Clear existing timeout
		if (draftSaveTimeoutRef.current) {
			clearTimeout(draftSaveTimeoutRef.current);
			draftSaveTimeoutRef.current = null;
		}

		// If sessionId changed, flush the previous session's draft immediately
		if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
			const prevSessionId = prevSessionIdRef.current;
			const trimmedContent = content.trim();

			// Fire-and-forget: save the current content as draft for the OLD session
			connectionManager.getHub().then((hub) => {
				hub
					.call('session.update', {
						sessionId: prevSessionId,
						metadata: {
							inputDraft: trimmedContent || undefined,
						},
					})
					.catch((error) => {
						console.error('Failed to flush draft on session switch:', error);
					});
			});
		}
		prevSessionIdRef.current = sessionId;

		const trimmedContent = content.trim();

		// Empty content: save immediately to ensure draft clears before any pending debounced save
		if (trimmedContent === '') {
			connectionManager.getHub().then((hub) => {
				hub
					.call('session.update', {
						sessionId,
						metadata: {
							inputDraft: undefined,
						},
					})
					.catch((error) => {
						console.error('Failed to clear draft:', error);
					});
			});
			return; // No cleanup needed for immediate save
		}

		// Non-empty content: debounce as usual
		draftSaveTimeoutRef.current = setTimeout(async () => {
			try {
				const hub = await connectionManager.getHub();
				await hub.call('session.update', {
					sessionId,
					metadata: {
						inputDraft: trimmedContent,
					},
				});
			} catch (error) {
				console.error('Failed to save draft:', error);
			}
		}, 250);

		return () => {
			if (draftSaveTimeoutRef.current) {
				clearTimeout(draftSaveTimeoutRef.current);
				draftSaveTimeoutRef.current = null;
			}
		};
	}, [content, sessionId]);

	// Global Escape key listener for interrupt (works even when textarea is disabled)
	useEffect(() => {
		const handleGlobalEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && isAgentWorking.value && !interrupting) {
				e.preventDefault();
				handleInterrupt();
			}
		};

		document.addEventListener('keydown', handleGlobalEscape);
		return () => document.removeEventListener('keydown', handleGlobalEscape);
	}, [interrupting]);

	// Load model info
	useEffect(() => {
		loadModelInfo();
	}, [sessionId]);

	// Close menu when clicking outside
	useEffect(() => {
		if (!menuOpen) return;

		const handleClickOutside = (event: MouseEvent) => {
			if (
				menuRef.current &&
				!menuRef.current.contains(event.target as Node) &&
				plusButtonRef.current &&
				!plusButtonRef.current.contains(event.target as Node)
			) {
				setMenuOpen(false);
				setShowModelSubmenu(false);
			}
		};

		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setMenuOpen(false);
				setShowModelSubmenu(false);
			}
		};

		// Delay to avoid immediate close from same click
		const timeoutId = setTimeout(() => {
			document.addEventListener('click', handleClickOutside);
			document.addEventListener('keydown', handleEscape);
		}, 0);

		return () => {
			clearTimeout(timeoutId);
			document.removeEventListener('click', handleClickOutside);
			document.removeEventListener('keydown', handleEscape);
		};
	}, [menuOpen]);

	const loadModelInfo = async () => {
		try {
			setLoadingModels(true);
			const hub = await connectionManager.getHub();

			// Fetch current model
			const { currentModel: modelId, modelInfo } = (await hub.call('session.model.get', {
				sessionId,
			})) as {
				currentModel: string;
				modelInfo: ModelInfo | null;
			};

			setCurrentModel(modelId);
			setCurrentModelInfo(modelInfo);

			// Fetch available models
			const { models } = (await hub.call('models.list', {
				useCache: true,
			})) as {
				models: Array<{ id: string; display_name: string; description: string }>;
			};

			const modelInfos: ModelInfo[] = models.map((m) => {
				let family: 'opus' | 'sonnet' | 'haiku' = 'sonnet';
				if (m.id.includes('opus')) family = 'opus';
				else if (m.id.includes('haiku')) family = 'haiku';

				return {
					id: m.id,
					name: m.display_name,
					alias: m.id.split('-').pop() || m.id,
					family,
					contextWindow: 200000,
					description: m.description || '',
					releaseDate: '',
					available: true,
				};
			});

			setAvailableModels(modelInfos);
		} catch (error) {
			console.error('Failed to load model info:', error);
		} finally {
			setLoadingModels(false);
		}
	};

	const handleModelSwitch = async (newModelId: string) => {
		if (newModelId === currentModel) {
			toast.info(`Already using ${currentModelInfo?.name || currentModel}`);
			setMenuOpen(false);
			setShowModelSubmenu(false);
			return;
		}

		try {
			setSwitching(true);
			const hub = await connectionManager.getHub();
			const result = (await hub.call('session.model.switch', {
				sessionId,
				model: newModelId,
			})) as {
				success: boolean;
				model: string;
				error?: string;
			};

			if (result.success) {
				setCurrentModel(result.model);
				const newModelInfo = availableModels.find((m) => m.id === result.model);
				setCurrentModelInfo(newModelInfo || null);
				toast.success(`Switched to ${newModelInfo?.name || result.model}`);
				setMenuOpen(false);
				setShowModelSubmenu(false);
			} else {
				toast.error(result.error || 'Failed to switch model');
			}
		} catch (error) {
			console.error('Model switch error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to switch model';
			toast.error(errorMessage);
		} finally {
			setSwitching(false);
		}
	};

	// Detect slash commands
	useEffect(() => {
		const trimmedContent = content.trimStart();

		if (trimmedContent.startsWith('/') && slashCommandsSignal.value.length > 0) {
			const query = trimmedContent.slice(1).toLowerCase();
			const filtered = slashCommandsSignal.value.filter((cmd) => cmd.toLowerCase().includes(query));

			setFilteredCommands(filtered);
			setShowCommandAutocomplete(filtered.length > 0);
			setSelectedCommandIndex(0);
		} else {
			setShowCommandAutocomplete(false);
			setFilteredCommands([]);
		}
	}, [content]);

	const handleSubmit = (e: Event) => {
		e.preventDefault();

		const messageContent = content.trim();
		if (!messageContent || isAgentWorking.value) {
			return;
		}

		// Clear UI - this triggers the draft save effect which will immediately clear the draft
		setContent('');

		// Send message
		onSend(messageContent);
	};

	const handleInterrupt = async () => {
		// Prevent multiple rapid interrupts
		if (interrupting) return;

		try {
			setInterrupting(true);
			const hub = await connectionManager.getHub();
			await hub.call('client.interrupt', { sessionId });
			// Don't show toast - the state change provides feedback
		} catch (error) {
			console.error('Interrupt error:', error);
			toast.error('Failed to stop generation');
		} finally {
			// Keep interrupting state until agent state changes to idle
			// This prevents UI flicker
			setTimeout(() => setInterrupting(false), 500);
		}
	};

	const handleCommandSelect = (command: string) => {
		setContent('/' + command + ' ');
		setShowCommandAutocomplete(false);
		textareaRef.current?.focus();
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		// Handle autocomplete navigation
		if (showCommandAutocomplete) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSelectedCommandIndex((prev) => (prev < filteredCommands.length - 1 ? prev + 1 : 0));
				return;
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSelectedCommandIndex((prev) => (prev > 0 ? prev - 1 : filteredCommands.length - 1));
				return;
			} else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
				e.preventDefault();
				if (filteredCommands[selectedCommandIndex]) {
					handleCommandSelect(filteredCommands[selectedCommandIndex]);
				}
				return;
			} else if (e.key === 'Escape') {
				e.preventDefault();
				setShowCommandAutocomplete(false);
				return;
			}
		}

		// Handle Enter key behavior
		if (e.key === 'Enter') {
			// Cmd+Enter or Ctrl+Enter always sends
			if (e.metaKey || e.ctrlKey) {
				e.preventDefault();
				handleSubmit(e);
				return;
			}

			// Desktop mode: Enter sends, Shift+Enter makes new line
			// Mobile mode: Enter makes new line, use send button to send
			if (!isMobileDevice.current && !e.shiftKey) {
				// Desktop: plain Enter sends message
				e.preventDefault();
				handleSubmit(e);
			}
			// Mobile or Shift+Enter: allow default behavior (new line)
		} else if (e.key === 'Escape') {
			// Escape key: interrupt if processing, otherwise clear content
			if (isAgentWorking.value && !interrupting) {
				e.preventDefault();
				handleInterrupt();
			} else if (!isAgentWorking.value) {
				setContent('');
				textareaRef.current?.blur();
			}
		}
	};

	const charCount = content.length;
	const showCharCount = charCount > maxChars * 0.8;
	const hasContent = content.trim().length > 0;
	// Use signal value in render to make component reactive
	const agentWorking = isAgentWorking.value;

	// Sort models by family order
	const familyOrder = { opus: 0, sonnet: 1, haiku: 2 };
	const sortedModels = [...availableModels].sort(
		(a, b) => familyOrder[a.family] - familyOrder[b.family]
	);

	return (
		<div class="p-4">
			<form onSubmit={handleSubmit} class="max-w-4xl mx-auto">
				{/* iOS 26 Style: Floating single-line input */}
				<div class="flex items-end gap-3">
					{/* Plus Button */}
					<div class="relative flex-shrink-0">
						<button
							ref={plusButtonRef}
							type="button"
							onClick={() => {
								setMenuOpen(!menuOpen);
								setShowModelSubmenu(false);
							}}
							class={cn(
								'w-[46px] h-[46px] rounded-full flex items-center justify-center transition-all',
								'bg-dark-700/80 border border-dark-600/50',
								'text-gray-300 hover:bg-dark-600 hover:text-white active:scale-95'
							)}
							title="More options"
						>
							<svg
								class={cn('w-5 h-5 transition-transform duration-200', menuOpen && 'rotate-45')}
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								stroke-width={2}
							>
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
							</svg>
						</button>

						{/* Menu Popover */}
						{menuOpen && (
							<div
								ref={menuRef}
								class="absolute bottom-full left-0 mb-2 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl overflow-hidden animate-slideIn min-w-[220px] z-50"
							>
								{/* Model Switcher */}
								<div class="relative">
									<button
										type="button"
										onClick={() => setShowModelSubmenu(!showModelSubmenu)}
										disabled={disabled || switching || loadingModels}
										class={cn(
											'w-full px-4 py-3 text-left flex items-center justify-between transition-colors',
											'text-gray-200 hover:bg-dark-700/50',
											(disabled || switching || loadingModels) && 'opacity-50 cursor-not-allowed'
										)}
									>
										<span class="flex items-center gap-3">
											{loadingModels ? (
												<div class="w-5 h-5 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
											) : switching ? (
												<div class="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
											) : currentModelInfo ? (
												<span class="text-lg">{MODEL_FAMILY_ICONS[currentModelInfo.family]}</span>
											) : (
												<span class="text-lg">🤖</span>
											)}
											<span class="text-sm">
												{loadingModels
													? 'Loading...'
													: switching
														? 'Switching...'
														: currentModelInfo?.name || 'Select Model'}
											</span>
										</span>
										<svg
											class={cn(
												'w-4 h-4 text-gray-400 transition-transform',
												showModelSubmenu && 'rotate-180'
											)}
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M9 5l7 7-7 7"
											/>
										</svg>
									</button>

									{/* Model Submenu */}
									{showModelSubmenu && !loadingModels && (
										<div class="border-t border-dark-600 bg-dark-850/50 max-h-[300px] overflow-y-auto">
											{sortedModels.map((model) => {
												const isCurrent = model.id === currentModel;
												return (
													<button
														key={model.id}
														type="button"
														onClick={() => handleModelSwitch(model.id)}
														disabled={disabled || switching}
														class={cn(
															'w-full px-4 py-2.5 text-left flex items-center justify-between transition-colors',
															isCurrent
																? 'text-blue-400 bg-blue-500/10'
																: 'text-gray-300 hover:bg-dark-700/50',
															(disabled || switching) && 'opacity-50 cursor-not-allowed'
														)}
													>
														<span class="flex items-center gap-3">
															<span class="text-base">{MODEL_FAMILY_ICONS[model.family]}</span>
															<span class="text-sm">{model.name}</span>
														</span>
														{isCurrent && (
															<svg
																class="w-4 h-4 text-blue-400"
																fill="none"
																viewBox="0 0 24 24"
																stroke="currentColor"
															>
																<path
																	stroke-linecap="round"
																	stroke-linejoin="round"
																	stroke-width={2.5}
																	d="M5 13l4 4L19 7"
																/>
															</svg>
														)}
													</button>
												);
											})}
										</div>
									)}
								</div>

								<div class="h-px bg-dark-600" />

								{/* Auto-scroll Toggle */}
								<button
									type="button"
									onClick={() => {
										onAutoScrollChange?.(!autoScroll);
										setMenuOpen(false);
									}}
									class="w-full px-4 py-3 text-left flex items-center justify-between transition-colors text-gray-200 hover:bg-dark-700/50"
								>
									<span class="flex items-center gap-3">
										<svg
											class={cn('w-5 h-5', autoScroll ? 'text-blue-400' : 'text-gray-400')}
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M19 14l-7 7m0 0l-7-7m7 7V3"
											/>
										</svg>
										<span class="text-sm">Auto-scroll</span>
									</span>
									{autoScroll && (
										<svg
											class="w-4 h-4 text-blue-400"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2.5}
												d="M5 13l4 4L19 7"
											/>
										</svg>
									)}
								</button>

								<div class="h-px bg-dark-600" />

								{/* Attach File (placeholder) */}
								<button
									type="button"
									onClick={() => {
										if (!disabled) {
											toast.info('File attachment coming soon');
											setMenuOpen(false);
										}
									}}
									disabled={disabled}
									class={cn(
										'w-full px-4 py-3 text-left flex items-center gap-3 transition-colors text-gray-200 hover:bg-dark-700/50',
										disabled && 'opacity-50 cursor-not-allowed'
									)}
								>
									<svg
										class="w-5 h-5 text-gray-400"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
										/>
									</svg>
									<span class="text-sm">Attach file</span>
								</button>
							</div>
						)}
					</div>

					{/* Input Pill */}
					<div class="relative flex-1">
						{/* Command Autocomplete */}
						{showCommandAutocomplete && (
							<CommandAutocomplete
								commands={filteredCommands}
								selectedIndex={selectedCommandIndex}
								onSelect={handleCommandSelect}
								onClose={() => setShowCommandAutocomplete(false)}
							/>
						)}

						<div
							class={cn(
								'relative rounded-3xl border transition-all',
								'bg-dark-800/60 backdrop-blur-sm',
								disabled
									? 'border-dark-700/30'
									: 'border-dark-600/50 focus-within:border-blue-500/50 focus-within:bg-dark-800/80'
							)}
						>
							{/* Textarea */}
							<textarea
								ref={textareaRef}
								value={content}
								onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
								onKeyDown={handleKeyDown}
								placeholder="Ask, search, or make anything..."
								maxLength={maxChars}
								rows={1}
								class={cn(
									'block w-full px-5 py-2.5 text-gray-100 resize-none bg-transparent',
									// Use 16px to prevent iOS Safari auto-zoom on focus (< 16px triggers zoom)
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
										'absolute top-1 right-12 text-xs',
										charCount >= maxChars ? 'text-red-400' : 'text-gray-500'
									)}
								>
									{charCount}/{maxChars}
								</div>
							)}

							{/* Send/Stop Button - shows stop when processing, send otherwise */}
							{agentWorking ? (
								<button
									type="button"
									onClick={handleInterrupt}
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
									type="submit"
									disabled={isAgentWorking.value || !hasContent}
									title={
										isMobileDevice.current ? 'Send message' : 'Send message (Enter or ⌘+Enter)'
									}
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
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											d="M5 10l7-7m0 0l7 7m-7-7v18"
										/>
									</svg>
								</button>
							)}
						</div>
					</div>
				</div>
			</form>
		</div>
	);
}
