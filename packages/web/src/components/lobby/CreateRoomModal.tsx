/**
 * CreateRoomModal Component
 *
 * Modal form for creating a new room with:
 * - Room name (required)
 * - Workspace path (required, pre-filled from daemon workspaceRoot when set; empty otherwise)
 * - Background context (optional)
 * - Form validation and error handling
 */

import { useRef, useState } from 'preact/hooks';
import { validateWorkspacePath } from '@neokai/shared';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

interface CreateRoomModalProps {
	isOpen: boolean;
	onClose: () => void;
	onSubmit: (params: { name: string; background?: string; defaultPath: string }) => Promise<void>;
}

export function CreateRoomModal({ isOpen, onClose, onSubmit }: CreateRoomModalProps) {
	const [name, setName] = useState('');
	const [workspacePath, setWorkspacePath] = useState(() => '');
	const [background, setBackground] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pathError, setPathError] = useState<string | null>(null);

	// Track whether the user has manually edited the path so we don't overwrite it
	// when systemState arrives late (WebSocket delivers state after mount).
	const userEditedPath = useRef(false);

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		if (!name.trim()) {
			setError('Room name is required');
			return;
		}

		const pathValidation = validateWorkspacePath(workspacePath);
		if (!pathValidation.valid) {
			setPathError(pathValidation.error ?? 'Invalid workspace path');
			return;
		}

		try {
			setSubmitting(true);
			setError(null);
			setPathError(null);

			await onSubmit({
				name: name.trim(),
				background: background.trim() || undefined,
				defaultPath: workspacePath.trim(),
			});

			// Reset form on success
			setName('');
			setBackground('');
			setWorkspacePath('');
			userEditedPath.current = false;
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create room');
		} finally {
			setSubmitting(false);
		}
	};

	const handleClose = () => {
		setName('');
		setBackground('');
		setWorkspacePath('');
		userEditedPath.current = false;
		setError(null);
		setPathError(null);
		onClose();
	};

	const handlePathInput = (value: string) => {
		userEditedPath.current = true;
		setWorkspacePath(value);
		if (pathError) {
			// Clear inline error as user types
			const result = validateWorkspacePath(value);
			if (result.valid) {
				setPathError(null);
			}
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="Create Room" size="md">
			<form onSubmit={handleSubmit} class="space-y-4">
				{error && (
					<div class="bg-red-900/20 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
						{error}
					</div>
				)}

				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">Room Name</label>
					<input
						type="text"
						value={name}
						onInput={(e) => setName((e.target as HTMLInputElement).value)}
						placeholder="e.g., Website Development, Bug Fixes"
						class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100
              placeholder-gray-500 focus:outline-none focus:border-blue-500"
						autoFocus
					/>
				</div>

				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						Workspace Path <span class="text-red-400">*</span>
					</label>
					<p class="text-xs text-gray-500 mb-2">Filesystem path for this room's workspace</p>
					<input
						type="text"
						value={workspacePath}
						onInput={(e) => handlePathInput((e.target as HTMLInputElement).value)}
						placeholder="/path/to/workspace"
						class={`w-full bg-dark-800 border rounded-lg px-4 py-2.5 text-gray-100
              placeholder-gray-500 focus:outline-none focus:border-blue-500 ${
								pathError ? 'border-red-700' : 'border-dark-700'
							}`}
					/>
					{pathError && <p class="mt-1 text-xs text-red-400">{pathError}</p>}
				</div>

				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						Background (optional)
					</label>
					<p class="text-xs text-gray-500 mb-2">
						Describe the project, its goals, and any important context for the AI agent.
					</p>
					<textarea
						value={background}
						onInput={(e) => setBackground((e.target as HTMLTextAreaElement).value)}
						placeholder="This room is focused on..."
						rows={4}
						class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100
              placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
					/>
				</div>

				<div class="flex gap-3 pt-2">
					<Button type="button" variant="secondary" onClick={handleClose} fullWidth>
						Cancel
					</Button>
					<Button type="submit" loading={submitting} fullWidth>
						Create Room
					</Button>
				</div>
			</form>
		</Modal>
	);
}
