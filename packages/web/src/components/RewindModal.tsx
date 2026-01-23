/**
 * RewindModal Component
 *
 * Displays available checkpoints for a session and allows the user to rewind
 * to a previous state. Shows preview of file changes before executing rewind.
 */

import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import type { Checkpoint, RewindPreview, RewindMode } from '@liuboer/shared';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { cn } from '../lib/utils';
import { toast } from '../lib/toast';
import { getCheckpoints, previewRewind, executeRewind } from '../lib/api-helpers';
import { ConnectionNotReadyError } from '../lib/errors';
import { borderColors } from '../lib/design-tokens';

interface RewindModalProps {
	isOpen: boolean;
	onClose: () => void;
	sessionId: string | null;
	/** Initial mode to select */
	initialMode?: RewindMode;
	/** Pre-selected checkpoint ID (for quick rewind from message) */
	preselectedCheckpointId?: string;
}

export function RewindModal({
	isOpen,
	onClose,
	sessionId,
	initialMode = 'files',
	preselectedCheckpointId,
}: RewindModalProps) {
	// Don't render if no sessionId
	if (!sessionId) {
		return null;
	}

	const loading = useSignal(true);
	const checkpoints = useSignal<Checkpoint[]>([]);
	const selectedCheckpoint = useSignal<string | null>(preselectedCheckpointId || null);
	const preview = useSignal<RewindPreview | null>(null);
	const previewLoading = useSignal(false);
	const executing = useSignal(false);
	const error = useSignal<string | null>(null);
	const selectedMode = useSignal<RewindMode>(initialMode);
	const showConfirmation = useSignal(false); // Confirmation step for destructive modes

	// Load checkpoints when modal opens
	useEffect(() => {
		if (isOpen && sessionId) {
			loadCheckpoints();
			// Reset mode to initial when opening
			selectedMode.value = initialMode;
			// Use preselected checkpoint if provided
			if (preselectedCheckpointId) {
				selectedCheckpoint.value = preselectedCheckpointId;
				// Load preview for preselected checkpoint
				handleSelectCheckpoint(preselectedCheckpointId);
			}
		} else {
			// Reset state when closed
			checkpoints.value = [];
			selectedCheckpoint.value = null;
			preview.value = null;
			error.value = null;
			selectedMode.value = initialMode;
			showConfirmation.value = false;
		}
	}, [isOpen, sessionId, preselectedCheckpointId]);

	const loadCheckpoints = async () => {
		if (!sessionId) return;

		loading.value = true;
		error.value = null;

		try {
			const result = await getCheckpoints(sessionId);
			if (result.error) {
				error.value = result.error;
			} else {
				// Sort checkpoints by turn number descending (newest first)
				checkpoints.value = [...result.checkpoints].sort((a, b) => b.turnNumber - a.turnNumber);
			}
		} catch (err) {
			if (err instanceof ConnectionNotReadyError) {
				error.value = 'Not connected to server';
			} else {
				error.value = err instanceof Error ? err.message : 'Failed to load checkpoints';
			}
		} finally {
			loading.value = false;
		}
	};

	const handleSelectCheckpoint = async (checkpointId: string) => {
		if (!sessionId) return;

		selectedCheckpoint.value = checkpointId;
		preview.value = null;
		previewLoading.value = true;

		try {
			const result = await previewRewind(sessionId, checkpointId);
			preview.value = result.preview;
		} catch (err) {
			if (err instanceof ConnectionNotReadyError) {
				toast.error('Not connected to server');
			} else {
				toast.error('Failed to load preview');
			}
		} finally {
			previewLoading.value = false;
		}
	};

	// Check if mode requires confirmation (destructive operations)
	const needsConfirmation = (mode: RewindMode) => mode === 'conversation' || mode === 'both';

	const handleRewindClick = () => {
		if (needsConfirmation(selectedMode.value)) {
			showConfirmation.value = true;
		} else {
			handleRewind();
		}
	};

	const handleRewind = async () => {
		if (!sessionId || !selectedCheckpoint.value) return;

		executing.value = true;
		showConfirmation.value = false;

		try {
			const mode = selectedMode.value;
			const result = await executeRewind(sessionId, selectedCheckpoint.value, mode);

			if (result.result.success) {
				// Build success message based on mode
				const filesCount = result.result.filesChanged?.length || 0;

				let message = '';
				if (mode === 'files') {
					message = `Rewound files to checkpoint (${filesCount} files restored)`;
				} else if (mode === 'conversation') {
					message = 'Rewound conversation to checkpoint';
				} else if (mode === 'both') {
					message = `Rewound to checkpoint (${filesCount} files + conversation)`;
				}

				toast.success(message);
				onClose();
			} else {
				toast.error(result.result.error || 'Failed to rewind');
			}
		} catch (err) {
			if (err instanceof ConnectionNotReadyError) {
				toast.error('Not connected to server');
			} else {
				toast.error(err instanceof Error ? err.message : 'Failed to rewind');
			}
		} finally {
			executing.value = false;
		}
	};

	const formatTime = (timestamp: number) => {
		const date = new Date(timestamp);
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	};

	const formatDate = (timestamp: number) => {
		const date = new Date(timestamp);
		const today = new Date();
		const isToday = date.toDateString() === today.toDateString();

		if (isToday) {
			return 'Today';
		}

		const yesterday = new Date(today);
		yesterday.setDate(yesterday.getDate() - 1);
		if (date.toDateString() === yesterday.toDateString()) {
			return 'Yesterday';
		}

		return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
	};

	// Get mode description text
	const getModeDescription = () => {
		switch (selectedMode.value) {
			case 'files':
				return 'Restore file changes only. The conversation will continue from the current point.';
			case 'conversation':
				return 'Resume conversation from this point. Messages after this checkpoint will be removed. Files remain unchanged.';
			case 'both':
				return 'Restore both files and conversation. This is a full rewind to the checkpoint state.';
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={onClose} title="Rewind to Checkpoint" size="lg">
			<div class="space-y-4">
				{/* Mode selection */}
				<div class="flex flex-wrap gap-3">
					<label class="flex items-center gap-2 cursor-pointer">
						<input
							type="radio"
							name="rewindMode"
							value="files"
							checked={selectedMode.value === 'files'}
							onChange={() => (selectedMode.value = 'files')}
							class="w-4 h-4 text-purple-500 bg-dark-800 border-gray-600 focus:ring-purple-500 focus:ring-offset-dark-900"
						/>
						<span class="text-sm text-gray-300">Files only</span>
					</label>
					<label class="flex items-center gap-2 cursor-pointer">
						<input
							type="radio"
							name="rewindMode"
							value="conversation"
							checked={selectedMode.value === 'conversation'}
							onChange={() => (selectedMode.value = 'conversation')}
							class="w-4 h-4 text-purple-500 bg-dark-800 border-gray-600 focus:ring-purple-500 focus:ring-offset-dark-900"
						/>
						<span class="text-sm text-gray-300">Conversation only</span>
					</label>
					<label class="flex items-center gap-2 cursor-pointer">
						<input
							type="radio"
							name="rewindMode"
							value="both"
							checked={selectedMode.value === 'both'}
							onChange={() => (selectedMode.value = 'both')}
							class="w-4 h-4 text-purple-500 bg-dark-800 border-gray-600 focus:ring-purple-500 focus:ring-offset-dark-900"
						/>
						<span class="text-sm text-gray-300">Both</span>
					</label>
				</div>

				{/* Description */}
				<p class="text-sm text-gray-400">{getModeDescription()}</p>

				{/* Error state */}
				{error.value && (
					<div class="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
						{error.value}
					</div>
				)}

				{/* Loading state */}
				{loading.value && (
					<div class="flex items-center justify-center py-8">
						<div class="animate-spin w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full" />
					</div>
				)}

				{/* Empty state */}
				{!loading.value && checkpoints.value.length === 0 && !error.value && (
					<div class="text-center py-8 text-gray-500">
						<svg
							class="w-12 h-12 mx-auto mb-3 text-gray-600"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={1.5}
								d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
							/>
						</svg>
						<p>No checkpoints available</p>
						<p class="text-sm mt-1">Checkpoints are created when you send messages to the agent.</p>
					</div>
				)}

				{/* Checkpoints list */}
				{!loading.value && checkpoints.value.length > 0 && (
					<div class="flex gap-4 min-h-[300px]">
						{/* Checkpoint list */}
						<div class="w-1/2 space-y-2 overflow-y-auto max-h-[400px] pr-2">
							{checkpoints.value.map((checkpoint) => (
								<button
									key={checkpoint.id}
									onClick={() => handleSelectCheckpoint(checkpoint.id)}
									class={cn(
										'w-full text-left p-3 rounded-lg border transition-colors',
										selectedCheckpoint.value === checkpoint.id
											? 'bg-purple-500/20 border-purple-500/50'
											: `bg-dark-800 ${borderColors.ui.default} hover:bg-dark-750`
									)}
								>
									<div class="flex items-center justify-between mb-1">
										<span class="text-xs font-medium text-purple-400">
											Turn {checkpoint.turnNumber}
										</span>
										<span class="text-xs text-gray-500">
											{formatDate(checkpoint.timestamp)} {formatTime(checkpoint.timestamp)}
										</span>
									</div>
									<p class="text-sm text-gray-300 line-clamp-2">
										{checkpoint.messagePreview || '(No preview)'}
									</p>
								</button>
							))}
						</div>

						{/* Preview panel */}
						<div class={`w-1/2 p-4 rounded-lg bg-dark-800 border ${borderColors.ui.default}`}>
							{!selectedCheckpoint.value && (
								<div class="h-full flex items-center justify-center text-gray-500 text-sm">
									Select a checkpoint to see preview
								</div>
							)}

							{selectedCheckpoint.value && previewLoading.value && (
								<div class="h-full flex items-center justify-center">
									<div class="animate-spin w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full" />
								</div>
							)}

							{selectedCheckpoint.value && !previewLoading.value && preview.value && (
								<div class="space-y-3">
									<h4 class="font-medium text-gray-200">Preview</h4>

									{!preview.value.canRewind && (
										<div class="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded text-yellow-400 text-sm">
											{preview.value.error || 'Cannot rewind to this checkpoint'}
										</div>
									)}

									{preview.value.canRewind && (
										<>
											{/* Stats */}
											<div class="grid grid-cols-2 gap-2 text-sm">
												<div class="p-2 bg-dark-750 rounded">
													<span class="text-gray-500">Files changed:</span>
													<span class="ml-2 text-gray-200">
														{preview.value.filesChanged?.length || 0}
													</span>
												</div>
												{(preview.value.insertions !== undefined ||
													preview.value.deletions !== undefined) && (
													<div class="p-2 bg-dark-750 rounded">
														<span class="text-green-400">+{preview.value.insertions || 0}</span>
														<span class="text-gray-500 mx-1">/</span>
														<span class="text-red-400">-{preview.value.deletions || 0}</span>
													</div>
												)}
											</div>

											{/* File list */}
											{preview.value.filesChanged && preview.value.filesChanged.length > 0 && (
												<div class="space-y-1 max-h-[200px] overflow-y-auto">
													<h5 class="text-xs font-medium text-gray-400 mb-2">Files to restore:</h5>
													{preview.value.filesChanged.map((file) => (
														<div
															key={file}
															class="text-xs font-mono text-gray-300 truncate"
															title={file}
														>
															{file}
														</div>
													))}
												</div>
											)}

											{preview.value.filesChanged?.length === 0 && (
												<p class="text-sm text-gray-500">No file changes to revert</p>
											)}
										</>
									)}
								</div>
							)}
						</div>
					</div>
				)}

				{/* Confirmation dialog for destructive modes */}
				{showConfirmation.value && (
					<div class="p-4 bg-red-500/10 border border-red-500/30 rounded-lg space-y-3">
						<div class="flex items-start gap-3">
							<svg
								class="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
								/>
							</svg>
							<div>
								<h4 class="font-medium text-red-400">This action cannot be undone</h4>
								<p class="text-sm text-gray-400 mt-1">
									{selectedMode.value === 'conversation'
										? 'Messages after this checkpoint will be permanently deleted from the conversation history.'
										: 'Files will be restored and messages after this checkpoint will be permanently deleted.'}
								</p>
							</div>
						</div>
						<div class="flex justify-end gap-3">
							<Button
								variant="ghost"
								onClick={() => (showConfirmation.value = false)}
								disabled={executing.value}
							>
								Cancel
							</Button>
							<Button
								variant="primary"
								onClick={handleRewind}
								disabled={executing.value}
								class="bg-red-600 hover:bg-red-700"
							>
								{executing.value ? 'Rewinding...' : 'Confirm Rewind'}
							</Button>
						</div>
					</div>
				)}

				{/* Actions */}
				{!showConfirmation.value && (
					<div class="flex justify-end gap-3 pt-4 border-t border-gray-700">
						<Button variant="ghost" onClick={onClose} disabled={executing.value}>
							Cancel
						</Button>
						<Button
							variant="primary"
							onClick={handleRewindClick}
							disabled={
								!selectedCheckpoint.value ||
								!preview.value?.canRewind ||
								previewLoading.value ||
								executing.value
							}
						>
							{executing.value ? 'Rewinding...' : 'Rewind'}
						</Button>
					</div>
				)}
			</div>
		</Modal>
	);
}
