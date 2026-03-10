/**
 * RoomContext - Edit room background context and instructions
 *
 * Provides editing for the two text fields that feed into agent system prompts:
 * - Background: Project context, goals, architecture notes
 * - Instructions: Behavioral guidelines for room agents
 */

import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { Room } from '@neokai/shared';
import { roomStore } from '../../lib/room-store';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { toast } from '../../lib/toast';

export interface RoomContextProps {
	room: Room;
}

export function RoomContext({ room }: RoomContextProps) {
	const background = useSignal(room.background || '');
	const instructions = useSignal(room.instructions || '');
	const isSaving = useSignal(false);

	// Sync with room props when they change
	useEffect(() => {
		background.value = room.background || '';
		instructions.value = room.instructions || '';
	}, [room]);

	const hasChanges = () => {
		return (
			background.value !== (room.background || '') ||
			instructions.value !== (room.instructions || '')
		);
	};

	const handleSave = async () => {
		if (!hasChanges()) return;

		isSaving.value = true;
		try {
			await roomStore.updateContext(background.value || undefined, instructions.value || undefined);
			toast.success('Context saved');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to save context');
		} finally {
			isSaving.value = false;
		}
	};

	const disabled = isSaving.value;

	return (
		<div class="flex flex-col h-full">
			{/* Header */}
			<div class="flex items-center justify-between pb-4 border-b border-dark-700">
				<h2 class="text-lg font-semibold text-gray-100">Room Context</h2>
			</div>

			{/* Content */}
			<div class="flex-1 overflow-y-auto py-4 space-y-6">
				{/* Background */}
				<div class="flex flex-col">
					<label for="room-background" class="block text-sm font-medium text-gray-300 mb-1.5">
						Background
					</label>
					<p class="text-xs text-gray-500 mb-2">
						Project context shared with all room agents. Describe the project, its architecture,
						goals, and any relevant technical details.
					</p>
					<textarea
						id="room-background"
						value={background.value}
						onInput={(e) => (background.value = (e.target as HTMLTextAreaElement).value)}
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-3 text-sm text-gray-100
							placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y font-mono"
						rows={12}
						placeholder="Describe the project context, architecture, and goals..."
						disabled={disabled}
					/>
				</div>

				{/* Instructions */}
				<div class="flex flex-col">
					<label for="room-instructions" class="block text-sm font-medium text-gray-300 mb-1.5">
						Instructions
					</label>
					<p class="text-xs text-gray-500 mb-2">
						Custom instructions for how room agents should behave. Coding standards, preferred
						tools, workflow guidelines, etc.
					</p>
					<textarea
						id="room-instructions"
						value={instructions.value}
						onInput={(e) => (instructions.value = (e.target as HTMLTextAreaElement).value)}
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-3 text-sm text-gray-100
							placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y font-mono"
						rows={8}
						placeholder="Add behavioral guidelines for room agents..."
						disabled={disabled}
					/>
				</div>
			</div>

			{/* Footer */}
			<div class="flex items-center justify-end gap-3 pt-4 border-t border-dark-700">
				{isSaving.value && (
					<span class="text-sm text-gray-400 flex items-center gap-2">
						<Spinner size="sm" />
						Saving...
					</span>
				)}
				<Button onClick={handleSave} disabled={!hasChanges() || disabled} loading={isSaving.value}>
					Save Changes
				</Button>
			</div>
		</div>
	);
}
