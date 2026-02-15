/**
 * CreateRoomModal Component
 *
 * Modal form for creating a new room with:
 * - Room name (required)
 * - Description (optional)
 * - Workspace paths (comma-separated, optional)
 * - Form validation and error handling
 */

import { useState } from 'preact/hooks';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

interface CreateRoomModalProps {
	isOpen: boolean;
	onClose: () => void;
	onSubmit: (params: {
		name: string;
		description?: string;
		allowedPaths?: string[];
		defaultPath?: string;
	}) => Promise<void>;
}

export function CreateRoomModal({ isOpen, onClose, onSubmit }: CreateRoomModalProps) {
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [pathsInput, setPathsInput] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		if (!name.trim()) {
			setError('Room name is required');
			return;
		}

		try {
			setSubmitting(true);
			setError(null);

			// Parse comma-separated paths into array
			const allowedPaths = pathsInput
				.split(',')
				.map((p) => p.trim())
				.filter((p) => p.length > 0);

			await onSubmit({
				name: name.trim(),
				description: description.trim() || undefined,
				allowedPaths: allowedPaths.length > 0 ? allowedPaths : undefined,
				defaultPath: allowedPaths.length > 0 ? allowedPaths[0] : undefined,
			});

			// Reset form on success
			setName('');
			setDescription('');
			setPathsInput('');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create room');
		} finally {
			setSubmitting(false);
		}
	};

	const handleClose = () => {
		setName('');
		setDescription('');
		setPathsInput('');
		setError(null);
		onClose();
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
						Description (optional)
					</label>
					<textarea
						value={description}
						onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
						placeholder="What will this room be used for?"
						rows={3}
						class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100
              placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
					/>
				</div>

				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						Workspace Paths (optional)
					</label>
					<input
						type="text"
						value={pathsInput}
						onInput={(e) => setPathsInput((e.target as HTMLInputElement).value)}
						placeholder="e.g., /home/user/project1, /home/user/project2"
						class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100
              placeholder-gray-500 focus:outline-none focus:border-blue-500"
					/>
					<p class="text-xs text-gray-500 mt-1">Comma-separated list of workspace paths</p>
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
