/**
 * ContextEditor - Edit room background and instructions
 *
 * Provides rich editing for room context with:
 * - Background text area (project description, goals, constraints)
 * - Instructions text area (custom agent behavior)
 * - Version history sidebar
 * - Save with confirmation
 * - Auto-save draft to localStorage
 */

import { signal, computed } from '@preact/signals';
import { useEffect, useCallback } from 'preact/hooks';
import type { Room, RoomContextVersion } from '@neokai/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { ContextVersionHistory } from './ContextVersionHistory';

// Maximum character limits
const MAX_BACKGROUND_LENGTH = 50000;
const MAX_INSTRUCTIONS_LENGTH = 50000;

// LocalStorage key for auto-save draft
const getDraftKey = (roomId: string) => `room-context-draft:${roomId}`;

export interface ContextEditorProps {
	/** Room to edit context for */
	room: Room;
	/** Handler for saving context changes */
	onSave: (background?: string, instructions?: string) => Promise<void>;
	/** Handler for rolling back to a previous version */
	onRollback: (version: number) => Promise<void>;
	/** Handler for fetching version history */
	onFetchVersions?: (roomId: string) => Promise<RoomContextVersion[]>;
	/** Whether the editor is in a loading state */
	isLoading?: boolean;
}

// Character count display component
function CharacterCount({ current, max }: { current: number; max: number }) {
	const isOverLimit = current > max;
	const isNearLimit = current > max * 0.9;

	return (
		<span
			class={cn(
				'text-xs',
				isOverLimit ? 'text-red-400' : isNearLimit ? 'text-yellow-400' : 'text-gray-500'
			)}
		>
			{current.toLocaleString()} / {max.toLocaleString()}
		</span>
	);
}

// Auto-resize textarea component
function AutoResizeTextarea({
	value,
	onChange,
	placeholder,
	maxLength,
	disabled,
	className,
	id,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	maxLength: number;
	disabled?: boolean;
	className?: string;
	id?: string;
}) {
	const textareaRef = useCallback(
		(node: HTMLTextAreaElement | null) => {
			if (node) {
				// Reset height to auto to get the correct scrollHeight
				node.style.height = 'auto';
				// Set height based on content, with min and max constraints
				const newHeight = Math.min(Math.max(node.scrollHeight, 100), 400);
				node.style.height = `${newHeight}px`;
			}
		},
		[value]
	);

	return (
		<textarea
			ref={textareaRef}
			id={id}
			value={value}
			onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
			placeholder={placeholder}
			maxLength={maxLength}
			disabled={disabled}
			class={cn(
				'w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100',
				'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
				'resize-none transition-all duration-200',
				'placeholder:text-gray-500',
				disabled && 'opacity-50 cursor-not-allowed',
				className
			)}
			rows={4}
		/>
	);
}

export function ContextEditor({
	room,
	onSave,
	onRollback,
	onFetchVersions,
	isLoading = false,
}: ContextEditorProps) {
	// Signals for state management
	const background = signal(room.background || '');
	const instructions = signal(room.instructions || '');
	const isSaving = signal(false);
	const isRollingBack = signal(false);
	const showVersionHistory = signal(false);
	const versions = signal<RoomContextVersion[]>([]);
	const isLoadingVersions = signal(false);
	const hasUnsavedChanges = signal(false);
	const draftLoaded = signal(false);

	// Computed values
	const hasChanges = computed(() => {
		const backgroundChanged = background.value !== (room.background || '');
		const instructionsChanged = instructions.value !== (room.instructions || '');
		return backgroundChanged || instructionsChanged;
	});

	const isBackgroundOverLimit = computed(() => background.value.length > MAX_BACKGROUND_LENGTH);
	const isInstructionsOverLimit = computed(
		() => instructions.value.length > MAX_INSTRUCTIONS_LENGTH
	);
	const canSave = computed(
		() =>
			hasChanges.value &&
			!isSaving.value &&
			!isLoading &&
			!isBackgroundOverLimit.value &&
			!isInstructionsOverLimit.value
	);

	// Load draft from localStorage on mount
	useEffect(() => {
		if (!draftLoaded.value) {
			try {
				const draftKey = getDraftKey(room.id);
				const savedDraft = localStorage.getItem(draftKey);
				if (savedDraft) {
					const { background: savedBg, instructions: savedInstr } = JSON.parse(savedDraft);
					// Only restore if different from current
					if (savedBg !== background.value || savedInstr !== instructions.value) {
						background.value = savedBg;
						instructions.value = savedInstr;
						hasUnsavedChanges.value = true;
					}
				}
			} catch {
				// Ignore parse errors
			}
			draftLoaded.value = true;
		}
	}, [room.id]);

	// Auto-save draft to localStorage
	useEffect(() => {
		if (!draftLoaded.value) return;

		const draftKey = getDraftKey(room.id);
		if (hasChanges.value) {
			localStorage.setItem(
				draftKey,
				JSON.stringify({
					background: background.value,
					instructions: instructions.value,
				})
			);
			hasUnsavedChanges.value = true;
		} else {
			localStorage.removeItem(draftKey);
			hasUnsavedChanges.value = false;
		}
	}, [background.value, instructions.value, hasChanges.value, room.id, draftLoaded.value]);

	// Sync with room props when they change
	useEffect(() => {
		if (!hasUnsavedChanges.value) {
			background.value = room.background || '';
			instructions.value = room.instructions || '';
		}
	}, [room.background, room.instructions, hasUnsavedChanges.value]);

	// Fetch versions when showing history
	useEffect(() => {
		if (showVersionHistory.value && onFetchVersions && versions.value.length === 0) {
			isLoadingVersions.value = true;
			onFetchVersions(room.id)
				.then((fetchedVersions) => {
					versions.value = fetchedVersions;
				})
				.finally(() => {
					isLoadingVersions.value = false;
				});
		}
	}, [showVersionHistory.value, room.id, onFetchVersions]);

	const handleSave = async () => {
		if (!canSave.value) return;

		isSaving.value = true;
		try {
			await onSave(background.value || undefined, instructions.value || undefined);
			// Clear draft on successful save
			localStorage.removeItem(getDraftKey(room.id));
			hasUnsavedChanges.value = false;
		} finally {
			isSaving.value = false;
		}
	};

	const handleRollback = async (version: number) => {
		isRollingBack.value = true;
		try {
			await onRollback(version);
			// Refresh versions after rollback
			if (onFetchVersions) {
				const fetchedVersions = await onFetchVersions(room.id);
				versions.value = fetchedVersions;
			}
		} finally {
			isRollingBack.value = false;
		}
	};

	const handleDiscardDraft = () => {
		background.value = room.background || '';
		instructions.value = room.instructions || '';
		localStorage.removeItem(getDraftKey(room.id));
		hasUnsavedChanges.value = false;
	};

	return (
		<div class="flex flex-col h-full">
			{/* Header */}
			<div class="flex items-center justify-between pb-4 border-b border-dark-700">
				<div class="flex items-center gap-3">
					<h2 class="text-lg font-semibold text-gray-100">Room Context</h2>
					{room.contextVersion && (
						<span class="px-2 py-0.5 text-xs font-medium bg-dark-700 text-gray-300 rounded">
							v{room.contextVersion}
						</span>
					)}
				</div>
				<div class="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => (showVersionHistory.value = !showVersionHistory.value)}
						disabled={isLoading || isSaving.value}
					>
						<svg class="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
							/>
						</svg>
						History
					</Button>
				</div>
			</div>

			{/* Main content area */}
			<div class="flex flex-1 gap-4 pt-4 overflow-hidden">
				{/* Editor panel */}
				<div
					class={cn(
						'flex-1 flex flex-col gap-4 overflow-y-auto',
						showVersionHistory.value && 'pr-4'
					)}
				>
					{/* Draft indicator */}
					{hasUnsavedChanges.value && (
						<div class="flex items-center justify-between px-3 py-2 bg-yellow-900/20 border border-yellow-800/50 rounded-lg">
							<span class="text-sm text-yellow-300">You have unsaved changes</span>
							<Button variant="ghost" size="sm" onClick={handleDiscardDraft}>
								Discard
							</Button>
						</div>
					)}

					{/* Background section */}
					<div>
						<div class="flex items-center justify-between mb-2">
							<label for="context-background" class="block text-sm font-medium text-gray-300">
								Background
							</label>
							<CharacterCount current={background.value.length} max={MAX_BACKGROUND_LENGTH} />
						</div>
						<p class="text-xs text-gray-500 mb-2">
							Describe the project, its goals, constraints, and any important context for the room
							agent.
						</p>
						<AutoResizeTextarea
							id="context-background"
							value={background.value}
							onChange={(val) => (background.value = val)}
							placeholder="This room is focused on..."
							maxLength={MAX_BACKGROUND_LENGTH}
							disabled={isLoading || isSaving.value}
						/>
					</div>

					{/* Instructions section */}
					<div>
						<div class="flex items-center justify-between mb-2">
							<label for="context-instructions" class="block text-sm font-medium text-gray-300">
								Instructions
							</label>
							<CharacterCount current={instructions.value.length} max={MAX_INSTRUCTIONS_LENGTH} />
						</div>
						<p class="text-xs text-gray-500 mb-2">
							Custom instructions for how the room agent should behave, including preferences,
							workflows, and communication style.
						</p>
						<AutoResizeTextarea
							id="context-instructions"
							value={instructions.value}
							onChange={(val) => (instructions.value = val)}
							placeholder="When working in this room..."
							maxLength={MAX_INSTRUCTIONS_LENGTH}
							disabled={isLoading || isSaving.value}
						/>
					</div>

					{/* Save button */}
					<div class="flex items-center justify-end gap-3 pt-4 border-t border-dark-700">
						{isSaving.value && (
							<span class="text-sm text-gray-400 flex items-center gap-2">
								<Spinner size="sm" />
								Saving...
							</span>
						)}
						<Button
							variant="ghost"
							onClick={handleDiscardDraft}
							disabled={!hasChanges.value || isLoading || isSaving.value}
						>
							Reset
						</Button>
						<Button onClick={handleSave} disabled={!canSave.value} loading={isSaving.value}>
							Save Changes
						</Button>
					</div>
				</div>

				{/* Version history sidebar */}
				{showVersionHistory.value && (
					<div class="w-80 flex-shrink-0 border-l border-dark-700 pl-4 overflow-y-auto">
						<ContextVersionHistory
							roomId={room.id}
							currentVersion={room.contextVersion || 1}
							versions={versions.value}
							onRollback={handleRollback}
							onViewVersion={(version) => {
								// For now, just populate the editor with the version content
								// A more sophisticated implementation would show a modal
								background.value = version.background || '';
								instructions.value = version.instructions || '';
							}}
							isLoading={isLoadingVersions.value || isRollingBack.value}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
