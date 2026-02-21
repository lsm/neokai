/**
 * RoomSettings - Edit room settings
 *
 * Provides editing for room configuration:
 * - Room name
 * - Default model (dropdown)
 * - Workspace paths with descriptions (folder picker)
 */

import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { Room, WorkspacePath } from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { toast } from '../../lib/toast';

export interface RoomSettingsProps {
	room: Room;
	onSave: (params: {
		name?: string;
		allowedPaths?: WorkspacePath[];
		defaultPath?: string;
		defaultModel?: string;
	}) => Promise<void>;
	isLoading?: boolean;
}

interface ModelInfo {
	id: string;
	name: string;
	display_name?: string;
}

export function RoomSettings({ room, onSave, isLoading = false }: RoomSettingsProps) {
	const name = useSignal(room.name);
	const defaultModel = useSignal(room.defaultModel || '');
	const allowedPaths = useSignal<WorkspacePath[]>([...room.allowedPaths]);
	const defaultPath = useSignal(room.defaultPath || '');
	const isSaving = useSignal(false);
	const isLoadingModels = useSignal(false);
	const availableModels = useSignal<ModelInfo[]>([]);
	const newPath = useSignal('');
	const newDescription = useSignal('');

	// Fetch available models
	useEffect(() => {
		const fetchModels = async () => {
			isLoadingModels.value = true;
			try {
				const hub = await connectionManager.getHub();
				const response = await hub.request<{ models: ModelInfo[] }>('models.list');
				availableModels.value = (response.models ?? []).map((m) => ({
					id: m.id,
					name: m.display_name ?? m.name ?? m.id,
				}));
			} catch {
				// Silently fail - models dropdown will just be empty
			} finally {
				isLoadingModels.value = false;
			}
		};
		fetchModels();
	}, []);

	// Sync with room props when they change
	useEffect(() => {
		name.value = room.name;
		defaultModel.value = room.defaultModel || '';
		allowedPaths.value = [...room.allowedPaths];
		defaultPath.value = room.defaultPath || '';
	}, [room]);

	const hasChanges = () => {
		return (
			name.value !== room.name ||
			defaultModel.value !== (room.defaultModel || '') ||
			JSON.stringify(allowedPaths.value) !== JSON.stringify(room.allowedPaths) ||
			defaultPath.value !== (room.defaultPath || '')
		);
	};

	const handleSave = async () => {
		if (!hasChanges()) return;

		isSaving.value = true;
		try {
			await onSave({
				name: name.value,
				defaultModel: defaultModel.value || undefined,
				allowedPaths: allowedPaths.value.length > 0 ? allowedPaths.value : undefined,
				defaultPath: defaultPath.value || undefined,
			});
			toast.success('Settings saved');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to save settings');
		} finally {
			isSaving.value = false;
		}
	};

	const handleAddPath = () => {
		const path = newPath.value.trim();
		if (path && !allowedPaths.value.some((p) => p.path === path)) {
			allowedPaths.value = [
				...allowedPaths.value,
				{ path, description: newDescription.value.trim() || undefined },
			];
			newPath.value = '';
			newDescription.value = '';
		}
	};

	const handleUpdatePathDescription = (pathToUpdate: string, description: string) => {
		allowedPaths.value = allowedPaths.value.map((p) =>
			p.path === pathToUpdate ? { ...p, description: description.trim() || undefined } : p
		);
	};

	const handleRemovePath = (pathToRemove: string) => {
		allowedPaths.value = allowedPaths.value.filter((p) => p.path !== pathToRemove);
		if (defaultPath.value === pathToRemove) {
			defaultPath.value = '';
		}
	};

	const handleSetDefaultPath = (path: string) => {
		defaultPath.value = defaultPath.value === path ? '' : path;
	};

	const handleFolderPick = async () => {
		try {
			const hub = await connectionManager.getHub();
			const response = await hub.request<{ path: string | null }>('dialog.pickFolder');
			if (response.path) {
				newPath.value = response.path;
			}
		} catch {
			toast.error('Failed to open folder picker');
		}
	};

	return (
		<div class="flex flex-col h-full">
			{/* Header */}
			<div class="flex items-center justify-between pb-4 border-b border-dark-700">
				<h2 class="text-lg font-semibold text-gray-100">Room Settings</h2>
			</div>

			{/* Content */}
			<div class="flex-1 overflow-y-auto py-4 space-y-6">
				{/* Room Name */}
				<div>
					<label for="room-name" class="block text-sm font-medium text-gray-300 mb-1.5">
						Room Name
					</label>
					<input
						id="room-name"
						type="text"
						value={name.value}
						onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
              placeholder-gray-500 focus:outline-none focus:border-blue-500"
						disabled={isLoading || isSaving.value}
					/>
				</div>

				{/* Default Model */}
				<div>
					<label for="default-model" class="block text-sm font-medium text-gray-300 mb-1.5">
						Default Model
					</label>
					<p class="text-xs text-gray-500 mb-2">
						Default model for new sessions in this room. Leave empty to use the system default.
					</p>
					<select
						id="default-model"
						value={defaultModel.value}
						onChange={(e) => (defaultModel.value = (e.target as HTMLSelectElement).value)}
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
              focus:outline-none focus:border-blue-500 appearance-none cursor-pointer"
						disabled={isLoading || isSaving.value || isLoadingModels.value}
					>
						<option value="">Use system default</option>
						{availableModels.value.map((model) => (
							<option key={model.id} value={model.id}>
								{model.name}
							</option>
						))}
					</select>
					{isLoadingModels.value && (
						<p class="text-xs text-gray-500 mt-1">Loading available models...</p>
					)}
				</div>

				{/* Workspace Paths */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">Workspace Paths</label>
					<p class="text-xs text-gray-500 mb-2">
						Allowed workspace paths for this room. The room agent can work on files in these
						directories.
					</p>

					{/* Path list */}
					<div class="space-y-2 mb-3">
						{allowedPaths.value.map((wp) => (
							<div key={wp.path} class="bg-dark-800 border border-dark-600 rounded-lg px-3 py-2">
								<div class="flex items-center gap-2">
									<span class="flex-1 text-sm text-gray-300 truncate font-mono">{wp.path}</span>
									<button
										type="button"
										onClick={() => handleSetDefaultPath(wp.path)}
										class={`text-xs px-2 py-1 rounded ${
											defaultPath.value === wp.path
												? 'bg-blue-600 text-white'
												: 'bg-dark-700 text-gray-400 hover:text-gray-200'
										}`}
										title="Set as default path"
									>
										{defaultPath.value === wp.path ? 'Default' : 'Set Default'}
									</button>
									<button
										type="button"
										onClick={() => handleRemovePath(wp.path)}
										class="text-gray-500 hover:text-red-400 p-1"
										title="Remove path"
									>
										<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M6 18L18 6M6 6l12 12"
											/>
										</svg>
									</button>
								</div>
								<input
									type="text"
									value={wp.description || ''}
									onInput={(e) =>
										handleUpdatePathDescription(wp.path, (e.target as HTMLInputElement).value)
									}
									placeholder="Add description (optional)"
									class="w-full mt-2 bg-dark-700 border border-dark-600 rounded px-2 py-1 text-xs
                      text-gray-400 placeholder-gray-600 focus:outline-none focus:border-gray-500"
									disabled={isLoading || isSaving.value}
								/>
							</div>
						))}
						{allowedPaths.value.length === 0 && (
							<p class="text-sm text-gray-500 italic">No workspace paths configured</p>
						)}
					</div>

					{/* Add new path */}
					<div class="space-y-2">
						<div class="flex gap-2">
							<input
								type="text"
								value={newPath.value}
								onInput={(e) => (newPath.value = (e.target as HTMLInputElement).value)}
								placeholder="/path/to/workspace"
								class="flex-1 bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100
                    placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
								disabled={isLoading || isSaving.value}
								onKeyDown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										handleAddPath();
									}
								}}
							/>
							<Button
								variant="secondary"
								size="sm"
								onClick={handleFolderPick}
								disabled={isLoading || isSaving.value}
								title="Browse folders"
							>
								<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
									/>
								</svg>
							</Button>
						</div>
						<input
							type="text"
							value={newDescription.value}
							onInput={(e) => (newDescription.value = (e.target as HTMLInputElement).value)}
							placeholder="Description for this path (optional)"
							class="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100
                  placeholder-gray-500 focus:outline-none focus:border-blue-500"
							disabled={isLoading || isSaving.value}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									handleAddPath();
								}
							}}
						/>
						<Button
							variant="secondary"
							size="sm"
							onClick={handleAddPath}
							disabled={!newPath.value.trim() || isLoading || isSaving.value}
						>
							Add Path
						</Button>
					</div>
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
				<Button
					onClick={handleSave}
					disabled={!hasChanges() || isLoading || isSaving.value}
					loading={isSaving.value}
				>
					Save Changes
				</Button>
			</div>
		</div>
	);
}
