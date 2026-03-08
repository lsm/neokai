/**
 * RoomSettings - Edit room settings
 *
 * Provides editing for room configuration:
 * - Room name
 * - Allowed models (checkboxes) + default model (dropdown filtered to allowed)
 * - Workspace paths with descriptions (folder picker)
 */

import { useSignal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import {
	type Room,
	type WorkspacePath,
	MAX_CONCURRENT_GROUPS_LIMIT,
	MAX_REVIEW_ROUNDS_LIMIT,
} from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { ConfirmModal } from '../ui/ConfirmModal';
import { toast } from '../../lib/toast';
import { t } from '../../lib/i18n';

export interface RoomSettingsProps {
	room: Room;
	onSave: (params: {
		name?: string;
		allowedPaths?: WorkspacePath[];
		defaultPath?: string;
		defaultModel?: string;
		allowedModels?: string[];
		config?: Record<string, unknown>;
	}) => Promise<void>;
	onArchive?: () => Promise<void>;
	onDelete?: () => Promise<void>;
	isLoading?: boolean;
}

interface ModelInfo {
	id: string;
	name: string;
	display_name?: string;
}

export function RoomSettings({
	room,
	onSave,
	onArchive,
	onDelete,
	isLoading = false,
}: RoomSettingsProps) {
	const name = useSignal(room.name);
	const defaultModel = useSignal(room.defaultModel || '');
	const allowedPaths = useSignal<WorkspacePath[]>([...room.allowedPaths]);
	const defaultPath = useSignal(room.defaultPath || '');
	// null = all allowed (no restriction); array = explicit set
	const allowedModels = useSignal<string[] | null>(room.allowedModels ?? null);
	const maxPlanningRetries = useSignal<number>(
		typeof (room.config as Record<string, unknown> | undefined)?.['maxPlanningRetries'] === 'number'
			? ((room.config as Record<string, unknown>)['maxPlanningRetries'] as number)
			: 0
	);
	const maxReviewRounds = useSignal<number>(
		typeof (room.config as Record<string, unknown> | undefined)?.['maxReviewRounds'] === 'number'
			? ((room.config as Record<string, unknown>)['maxReviewRounds'] as number)
			: 3
	);
	const maxConcurrentGroups = useSignal<number>(
		typeof (room.config as Record<string, unknown> | undefined)?.['maxConcurrentGroups'] === 'number'
			? ((room.config as Record<string, unknown>)['maxConcurrentGroups'] as number)
			: 1
	);
	const isSaving = useSignal(false);
	const [showArchiveModal, setShowArchiveModal] = useState(false);
	const [isArchiving, setIsArchiving] = useState(false);
	const [showDeleteModal, setShowDeleteModal] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
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
				// Silently fail - models list will just be empty
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
		allowedModels.value = room.allowedModels ?? null;
		const cfg = (room.config as Record<string, unknown> | undefined) ?? {};
		maxPlanningRetries.value =
			typeof cfg['maxPlanningRetries'] === 'number' ? (cfg['maxPlanningRetries'] as number) : 0;
		maxReviewRounds.value =
			typeof cfg['maxReviewRounds'] === 'number' ? (cfg['maxReviewRounds'] as number) : 3;
		maxConcurrentGroups.value =
			typeof cfg['maxConcurrentGroups'] === 'number' ? (cfg['maxConcurrentGroups'] as number) : 1;
	}, [room]);

	// Models visible in the default model dropdown (only allowed ones, or all if no restriction)
	const selectableModels = () => {
		const allowed = allowedModels.value;
		if (!allowed || allowed.length === 0) return availableModels.value;
		return availableModels.value.filter((m) => allowed.includes(m.id));
	};

	const isModelAllowed = (modelId: string) => {
		const allowed = allowedModels.value;
		if (!allowed) return true; // all allowed
		return allowed.includes(modelId);
	};

	const handleToggleModel = (modelId: string) => {
		const current = allowedModels.value;
		// If currently unrestricted, switching on means "all except this one" — instead
		// start an explicit set with all checked except this one unchecked.
		const base = current ?? availableModels.value.map((m) => m.id);
		const next = base.includes(modelId) ? base.filter((id) => id !== modelId) : [...base, modelId];
		// If every model is checked, go back to unrestricted (null)
		allowedModels.value =
			next.length === availableModels.value.length ? null : next.length === 0 ? [] : next;

		// Clear default model if it's no longer selectable
		if (defaultModel.value && !next.includes(defaultModel.value)) {
			defaultModel.value = '';
		}
	};

	const handleSelectAllModels = () => {
		allowedModels.value = null; // unrestricted
	};

	const handleDeselectAllModels = () => {
		allowedModels.value = [];
	};

	const hasChanges = () => {
		const origAllowed = room.allowedModels ?? null;
		const currAllowed = allowedModels.value;
		const modelsChanged =
			JSON.stringify(origAllowed?.slice().sort()) !== JSON.stringify(currAllowed?.slice().sort());

		const cfg = (room.config as Record<string, unknown> | undefined) ?? {};
		const origMaxRetries =
			typeof cfg['maxPlanningRetries'] === 'number' ? (cfg['maxPlanningRetries'] as number) : 0;
		const origMaxReview =
			typeof cfg['maxReviewRounds'] === 'number' ? (cfg['maxReviewRounds'] as number) : 3;
		const origMaxConcurrent =
			typeof cfg['maxConcurrentGroups'] === 'number'
				? (cfg['maxConcurrentGroups'] as number)
				: 1;

		return (
			name.value !== room.name ||
			defaultModel.value !== (room.defaultModel || '') ||
			JSON.stringify(allowedPaths.value) !== JSON.stringify(room.allowedPaths) ||
			defaultPath.value !== (room.defaultPath || '') ||
			modelsChanged ||
			maxPlanningRetries.value !== origMaxRetries ||
			maxReviewRounds.value !== origMaxReview ||
			maxConcurrentGroups.value !== origMaxConcurrent
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
				// null → send empty array to mean "all allowed"; explicit list → send list
				allowedModels: allowedModels.value ?? [],
				config: {
					...(room.config as Record<string, unknown> | undefined),
					maxPlanningRetries: maxPlanningRetries.value,
					maxReviewRounds: maxReviewRounds.value,
					maxConcurrentGroups: maxConcurrentGroups.value,
				},
			});
			toast.success(t('roomSettings.saved'));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t('roomSettings.saveFailed'));
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
			toast.error(t('roomSettings.folderPickerFailed'));
		}
	};

	const disabled = isLoading || isSaving.value;

	return (
		<div class="flex flex-col h-full">
			{/* Header */}
			<div class="flex items-center justify-between pb-4 border-b border-dark-700">
				<h2 class="text-lg font-semibold text-gray-100">{t('roomSettings.roomSettings')}</h2>
			</div>

			{/* Content */}
			<div class="flex-1 overflow-y-auto py-4 space-y-6">
				{/* Room Name */}
				<div>
					<label for="room-name" class="block text-sm font-medium text-gray-300 mb-1.5">
						{t('roomSettings.roomName')}
					</label>
					<input
						id="room-name"
						type="text"
						value={name.value}
						onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
              placeholder-gray-500 focus:outline-none focus:border-blue-500"
						disabled={disabled}
					/>
				</div>

				{/* Max Planning Retries */}
				<div>
					<label for="max-planning-retries" class="block text-sm font-medium text-gray-300 mb-1.5">
						{t('roomSettings.maxPlanningRetries')}
					</label>
					<p class="text-xs text-gray-500 mb-2">
						{t('roomSettings.maxPlanningRetriesDesc')}
					</p>
					<input
						id="max-planning-retries"
						type="number"
						min={0}
						max={5}
						value={maxPlanningRetries.value}
						onInput={(e) => {
							const v = parseInt((e.target as HTMLInputElement).value, 10);
							if (!isNaN(v) && v >= 0 && v <= 5) maxPlanningRetries.value = v;
						}}
						class="w-24 bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
              focus:outline-none focus:border-blue-500"
						disabled={disabled}
					/>
				</div>

				{/* Max Review Rounds */}
				<div>
					<label for="max-review-rounds" class="block text-sm font-medium text-gray-300 mb-1.5">
						{t('roomSettings.maxReviewRounds')}
					</label>
					<p class="text-xs text-gray-500 mb-2">
						{t('roomSettings.maxReviewRoundsDesc')}
					</p>
					<input
						id="max-review-rounds"
						type="number"
						min={1}
						max={MAX_REVIEW_ROUNDS_LIMIT}
						value={maxReviewRounds.value}
						onInput={(e) => {
							const v = parseInt((e.target as HTMLInputElement).value, 10);
							if (!isNaN(v) && v >= 1 && v <= MAX_REVIEW_ROUNDS_LIMIT)
								maxReviewRounds.value = v;
						}}
						class="w-24 bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
              focus:outline-none focus:border-blue-500"
						disabled={disabled}
					/>
				</div>

				{/* Max Concurrent Tasks */}
				<div>
					<label for="max-concurrent-groups" class="block text-sm font-medium text-gray-300 mb-1.5">
						{t('roomSettings.maxConcurrentTasks')}
					</label>
					<p class="text-xs text-gray-500 mb-2">
						{t('roomSettings.maxConcurrentTasksDesc')}
					</p>
					<input
						id="max-concurrent-groups"
						type="number"
						min={1}
						max={MAX_CONCURRENT_GROUPS_LIMIT}
						value={maxConcurrentGroups.value}
						onInput={(e) => {
							const v = parseInt((e.target as HTMLInputElement).value, 10);
							if (!isNaN(v) && v >= 1 && v <= MAX_CONCURRENT_GROUPS_LIMIT)
								maxConcurrentGroups.value = v;
						}}
						class="w-24 bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
              focus:outline-none focus:border-blue-500"
						disabled={disabled}
					/>
				</div>

				{/* Allowed Models */}
				<div>
					<div class="flex items-center justify-between mb-1.5">
						<label class="block text-sm font-medium text-gray-300">{t('roomSettings.allowedModels')}</label>
						{!isLoadingModels.value && availableModels.value.length > 0 && (
							<div class="flex gap-2">
								<button
									type="button"
									onClick={handleSelectAllModels}
									class="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40"
									disabled={disabled || allowedModels.value === null}
								>
									{t('roomSettings.selectAll')}
								</button>
								<span class="text-xs text-gray-600">·</span>
								<button
									type="button"
									onClick={handleDeselectAllModels}
									class="text-xs text-gray-400 hover:text-gray-300 disabled:opacity-40"
									disabled={disabled}
								>
									{t('roomSettings.selectNone')}
								</button>
							</div>
						)}
					</div>
					<p class="text-xs text-gray-500 mb-2">
						{t('roomSettings.allowedModelsDesc')}
					</p>
					{isLoadingModels.value ? (
						<p class="text-xs text-gray-500">{t('roomSettings.loadingModels')}</p>
					) : availableModels.value.length === 0 ? (
						<p class="text-xs text-gray-500 italic">{t('roomSettings.noModels')}</p>
					) : (
						<div class="space-y-1.5">
							{availableModels.value.map((model) => (
								<label key={model.id} class="flex items-center gap-2.5 cursor-pointer group">
									<input
										type="checkbox"
										checked={isModelAllowed(model.id)}
										onChange={() => handleToggleModel(model.id)}
										disabled={disabled}
										class="w-4 h-4 rounded border-dark-500 bg-dark-800 text-blue-500
                      focus:ring-blue-500 focus:ring-offset-dark-900 cursor-pointer"
									/>
									<span class="text-sm text-gray-300 group-hover:text-gray-100 transition-colors">
										{model.name}
									</span>
									{model.id === defaultModel.value && (
										<span class="text-xs text-blue-400 ml-auto">{t('roomSettings.default')}</span>
									)}
								</label>
							))}
						</div>
					)}
				</div>

				{/* Default Model */}
				<div>
					<label for="default-model" class="block text-sm font-medium text-gray-300 mb-1.5">
						{t('roomSettings.defaultModel')}
					</label>
					<p class="text-xs text-gray-500 mb-2">
						{t('roomSettings.defaultModelDesc')}
					</p>
					<select
						id="default-model"
						value={defaultModel.value}
						onChange={(e) => (defaultModel.value = (e.target as HTMLSelectElement).value)}
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
              focus:outline-none focus:border-blue-500 appearance-none cursor-pointer"
						disabled={disabled || isLoadingModels.value}
					>
						<option value="">{t('roomSettings.useSystemDefault')}</option>
						{selectableModels().map((model) => (
							<option key={model.id} value={model.id}>
								{model.name}
							</option>
						))}
					</select>
				</div>

				{/* Workspace Paths */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">{t('roomSettings.workspacePaths')}</label>
					<p class="text-xs text-gray-500 mb-2">
						{t('roomSettings.workspacePathsDesc')}
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
										{defaultPath.value === wp.path ? t('roomSettings.default') : t('roomSettings.setDefault')}
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
									placeholder={t('roomSettings.addDescriptionPlaceholder')}
									class="w-full mt-2 bg-dark-700 border border-dark-600 rounded px-2 py-1 text-xs
                      text-gray-400 placeholder-gray-600 focus:outline-none focus:border-gray-500"
									disabled={disabled}
								/>
							</div>
						))}
						{allowedPaths.value.length === 0 && (
							<p class="text-sm text-gray-500 italic">{t('roomSettings.noWorkspacePaths')}</p>
						)}
					</div>

					{/* Add new path */}
					<div class="space-y-2">
						<div class="flex gap-2">
							<input
								type="text"
								value={newPath.value}
								onInput={(e) => (newPath.value = (e.target as HTMLInputElement).value)}
								placeholder={t('roomSettings.pathPlaceholder')}
								class="flex-1 bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100
                    placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
								disabled={disabled}
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
								disabled={disabled}
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
							placeholder={t('roomSettings.descriptionPlaceholder')}
							class="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100
                  placeholder-gray-500 focus:outline-none focus:border-blue-500"
							disabled={disabled}
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
							disabled={!newPath.value.trim() || disabled}
						>
							{t('roomSettings.addPath')}
						</Button>
					</div>
				</div>

				{/* Danger Zone */}
				{(onArchive ?? onDelete) && (
					<div class="border border-red-900/50 rounded-lg overflow-hidden">
						<div class="px-4 py-2.5 bg-red-950/30">
							<h3 class="text-sm font-semibold text-red-400">{t('roomSettings.dangerZone')}</h3>
						</div>
						<div class="divide-y divide-red-900/30">
							{onArchive && (
								<div class="px-4 py-3 flex items-center justify-between gap-4">
									<div class="min-w-0">
										<p class="text-sm font-medium text-gray-200">{t('roomSettings.archiveRoomLabel')}</p>
										<p class="text-xs text-gray-500 mt-0.5">
											{t('roomSettings.archiveDesc')}
										</p>
									</div>
									<button
										type="button"
										onClick={() => setShowArchiveModal(true)}
										disabled={disabled}
										class="flex-shrink-0 px-3 py-1.5 text-xs font-medium border border-yellow-700/60 text-yellow-400 hover:bg-yellow-900/20 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
									>
										{t('roomSettings.archive')}
									</button>
								</div>
							)}
							{onDelete && (
								<div class="px-4 py-3 flex items-center justify-between gap-4">
									<div class="min-w-0">
										<p class="text-sm font-medium text-gray-200">{t('roomSettings.deleteRoom')}</p>
										<p class="text-xs text-gray-500 mt-0.5">
											{t('roomSettings.deleteDesc')}
										</p>
									</div>
									<button
										type="button"
										onClick={() => setShowDeleteModal(true)}
										disabled={disabled}
										class="flex-shrink-0 px-3 py-1.5 text-xs font-medium border border-red-700/60 text-red-400 hover:bg-red-900/20 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
									>
										{t('common.delete')}
									</button>
								</div>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Footer */}
			<div class="flex items-center justify-end gap-3 pt-4 border-t border-dark-700">
				{isSaving.value && (
					<span class="text-sm text-gray-400 flex items-center gap-2">
						<Spinner size="sm" />
						{t('roomSettings.saving')}
					</span>
				)}
				<Button onClick={handleSave} disabled={!hasChanges() || disabled} loading={isSaving.value}>
					{t('roomSettings.saveChanges')}
				</Button>
			</div>

			{/* Danger zone modals */}
			<ConfirmModal
				isOpen={showArchiveModal}
				onClose={() => setShowArchiveModal(false)}
				onConfirm={async () => {
					setIsArchiving(true);
					try {
						await onArchive?.();
					} finally {
						setIsArchiving(false);
						setShowArchiveModal(false);
					}
				}}
				title={t('roomSettings.archiveTitle')}
				message={t('roomSettings.archiveConfirm')}
				confirmText={t('roomSettings.archiveRoom')}
				confirmButtonVariant="primary"
				isLoading={isArchiving}
			/>
			<ConfirmModal
				isOpen={showDeleteModal}
				onClose={() => setShowDeleteModal(false)}
				onConfirm={async () => {
					setIsDeleting(true);
					try {
						await onDelete?.();
					} finally {
						setIsDeleting(false);
						setShowDeleteModal(false);
					}
				}}
				title={t('roomSettings.deleteTitle')}
				message={t('roomSettings.deleteConfirm')}
				confirmText={t('roomSettings.deletePermanently')}
				confirmButtonVariant="danger"
				isLoading={isDeleting}
			/>
		</div>
	);
}
