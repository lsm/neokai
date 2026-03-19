/**
 * NewSessionModal Component
 *
 * Modal for creating a new session with:
 * - Recent paths dropdown (top 5-10 recent paths with timestamps)
 * - Optional room assignment dropdown (shows room name + allowedPaths count)
 * - "Create new room" option that opens inline form
 * - "Browse for folder" button
 * - Optional model selector (provider-grouped)
 * - Form validation and error handling
 */

import { useState, useEffect } from 'preact/hooks';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import type { Room, ModelInfo } from '@neokai/shared';
import type { ProviderAuthStatus } from '@neokai/shared/provider';
import { connectionManager } from '../../lib/connection-manager';
import {
	groupModelsByProvider,
	getProviderLabel,
	mapRawModelsToModelInfos,
	filterModelsForPicker,
} from '../../hooks/useModelSwitcher';
import type { RawModelEntry } from '../../hooks/useModelSwitcher';

interface RecentPath {
	path: string;
	relativeTime: string;
	absoluteTime: Date;
}

/** Fetch available models from the server, mapped and sorted via shared utility */
async function fetchAvailableModels(): Promise<import('@neokai/shared').ModelInfo[]> {
	const hub = connectionManager.getHubIfConnected();
	if (!hub) return [];
	const { models } = (await hub.request('models.list', { useCache: true })) as {
		models: RawModelEntry[];
	};
	return mapRawModelsToModelInfos(models);
}

/** Fetch provider auth statuses from the server */
async function fetchProviderAuthStatuses(): Promise<Map<string, ProviderAuthStatus>> {
	const hub = connectionManager.getHubIfConnected();
	if (!hub) return new Map();
	const result = (await hub.request('auth.providers', {})) as {
		providers?: ProviderAuthStatus[];
	} | null;
	const map = new Map<string, ProviderAuthStatus>();
	for (const p of result?.providers ?? []) {
		map.set(p.id, p);
	}
	return map;
}

interface NewSessionModalProps {
	isOpen: boolean;
	onClose: () => void;
	onSubmit: (params: {
		workspacePath: string;
		roomId?: string;
		model?: ModelInfo;
	}) => Promise<void>;
	recentPaths: RecentPath[];
	rooms: Room[];
	onCreateRoom?: (params: {
		name: string;
		background?: string;
		allowedPaths?: { path: string; description?: string }[];
		defaultPath?: string;
	}) => Promise<Room | null>;
}

export function NewSessionModal({
	isOpen,
	onClose,
	onSubmit,
	recentPaths,
	rooms,
	onCreateRoom,
}: NewSessionModalProps) {
	const [selectedPath, setSelectedPath] = useState<string>('');
	const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showCreateRoom, setShowCreateRoom] = useState(false);
	const [newRoomName, setNewRoomName] = useState('');
	const [newRoomDescription, setNewRoomDescription] = useState('');
	const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
	const [providerAuthStatuses, setProviderAuthStatuses] = useState<Map<string, ProviderAuthStatus>>(
		new Map()
	);
	// Empty string = "Default (server setting)"; non-empty = "provider:id"
	const [selectedModelKey, setSelectedModelKey] = useState<string>('');

	useEffect(() => {
		if (!isOpen) return;
		// Fetch both together so a failure in either suppresses the model picker atomically.
		// If auth status cannot be determined we must not show unfiltered models, and since
		// both promises are resolved together there is no window where models repopulate
		// after an auth failure.
		Promise.all([fetchAvailableModels(), fetchProviderAuthStatuses()])
			.then(([models, statuses]) => {
				setAvailableModels(models);
				setProviderAuthStatuses(statuses);
			})
			.catch(() => {
				// Either models or auth unavailable — keep model picker hidden
			});
	}, [isOpen]);

	/** Resolve the selected model by composite key `provider:id` */
	function resolveSelectedModel(): ModelInfo | undefined {
		if (!selectedModelKey) return undefined;
		const colonIdx = selectedModelKey.indexOf(':');
		const provider = selectedModelKey.slice(0, colonIdx);
		const id = selectedModelKey.slice(colonIdx + 1);
		return availableModels.find((m) => m.provider === provider && m.id === id);
	}

	const handleSubmit = async (e: Event) => {
		e.preventDefault();

		const workspacePath = selectedPath.trim();
		if (!workspacePath) {
			setError('Workspace path is required');
			return;
		}

		try {
			setSubmitting(true);
			setError(null);

			await onSubmit({
				workspacePath,
				roomId: selectedRoomId || undefined,
				model: resolveSelectedModel(),
			});

			// Reset form on success
			setSelectedPath('');
			setSelectedRoomId(undefined);
			setSelectedModelKey('');
			setShowCreateRoom(false);
			setNewRoomName('');
			setNewRoomDescription('');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create session');
		} finally {
			setSubmitting(false);
		}
	};

	const handleCreateRoom = async () => {
		if (!newRoomName.trim()) {
			setError('Room name is required');
			return;
		}

		if (!onCreateRoom) {
			setError('Create room not available');
			return;
		}

		try {
			setSubmitting(true);
			setError(null);

			const room = await onCreateRoom({
				name: newRoomName.trim(),
				background: newRoomDescription.trim() || undefined,
				allowedPaths: [{ path: selectedPath }],
				defaultPath: selectedPath,
			});

			if (room) {
				setSelectedRoomId(room.id);
				setShowCreateRoom(false);
				setNewRoomName('');
				setNewRoomDescription('');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create room');
		} finally {
			setSubmitting(false);
		}
	};

	const handleClose = () => {
		setSelectedPath('');
		setSelectedRoomId(undefined);
		setSelectedModelKey('');
		setAvailableModels([]);
		setProviderAuthStatuses(new Map());
		setShowCreateRoom(false);
		setNewRoomName('');
		setNewRoomDescription('');
		setError(null);
		onClose();
	};

	// Filter out unauthenticated providers; no "current provider" to preserve in new session context
	const groupedModels = groupModelsByProvider(
		filterModelsForPicker(availableModels, providerAuthStatuses)
	);

	const handleBrowseFolder = () => {
		// Trigger file browser dialog
		// This will need to be implemented via an RPC call or file input
		// For now, just focus the path input
		setError('Browse functionality coming soon');
	};

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="New Session" size="md">
			<form onSubmit={handleSubmit} class="space-y-5">
				{error && (
					<div class="bg-red-900/20 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
						{error}
					</div>
				)}

				{/* Workspace Path Section */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						Where do you want to work?
					</label>

					{/* Recent Paths Dropdown */}
					{recentPaths.length > 0 && (
						<div class="mb-3">
							<select
								value={selectedPath}
								onChange={(e) => setSelectedPath((e.target as HTMLSelectElement).value)}
								class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-blue-500 cursor-pointer"
							>
								<option value="">Select a recent path...</option>
								{recentPaths.map((item) => (
									<option key={item.path} value={item.path}>
										{item.path} ({item.relativeTime})
									</option>
								))}
							</select>
						</div>
					)}

					<div class="text-center text-sm text-gray-500 py-1">or</div>

					{/* Path Input */}
					<input
						type="text"
						data-testid="new-session-workspace-input"
						value={selectedPath}
						onInput={(e) => setSelectedPath((e.target as HTMLInputElement).value)}
						placeholder="Enter workspace path..."
						class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
					/>

					{/* Browse Button */}
					<button
						type="button"
						onClick={handleBrowseFolder}
						class="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm text-gray-300 bg-dark-800 hover:bg-dark-700 border border-dark-700 rounded-lg transition-colors"
					>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
							/>
						</svg>
						Browse for folder...
					</button>
				</div>

				{/* Model Selection Section */}
				{availableModels.length > 0 && (
					<div>
						<label class="block text-sm font-medium text-gray-300 mb-1.5">Model (optional)</label>
						<select
							value={selectedModelKey}
							onChange={(e) => setSelectedModelKey((e.target as HTMLSelectElement).value)}
							class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-blue-500 cursor-pointer"
						>
							<option value="">Default (server setting)</option>
							{Array.from(groupedModels.entries()).map(([provider, models]) => {
								const authStatus = providerAuthStatuses.get(provider);
								const needsRefresh = authStatus?.needsRefresh ?? false;
								const groupLabel = needsRefresh
									? `${getProviderLabel(provider)} ⚠ (token expiring)`
									: getProviderLabel(provider);
								return (
									<optgroup key={provider} label={groupLabel}>
										{models.map((model) => (
											<option
												key={`${model.provider}:${model.id}`}
												value={`${model.provider}:${model.id}`}
											>
												{model.name}
											</option>
										))}
									</optgroup>
								);
							})}
						</select>
					</div>
				)}

				{/* Room Assignment Section */}
				{!showCreateRoom && (
					<div>
						<label class="block text-sm font-medium text-gray-300 mb-1.5">
							Assign to Room (optional)
						</label>

						<select
							value={selectedRoomId ?? ''}
							onChange={(e) => {
								const value = (e.target as HTMLSelectElement).value;
								if (value === '__create__') {
									setShowCreateRoom(true);
								} else if (value === '') {
									setSelectedRoomId(undefined);
								} else {
									setSelectedRoomId(value);
								}
							}}
							class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-blue-500 cursor-pointer"
						>
							<option value="">No room</option>
							{rooms.map((room) => (
								<option key={room.id} value={room.id}>
									{room.name} ({room.allowedPaths.length} path
									{room.allowedPaths.length !== 1 ? 's' : ''})
								</option>
							))}
							{onCreateRoom && <option value="__create__">+ Create new room...</option>}
						</select>
					</div>
				)}

				{/* Create Room Inline Form */}
				{showCreateRoom && (
					<div class="bg-dark-800/50 border border-dark-700 rounded-lg p-4 space-y-3">
						<div class="flex items-center justify-between">
							<h3 class="text-sm font-medium text-gray-300">Create New Room</h3>
							<button
								type="button"
								onClick={() => setShowCreateRoom(false)}
								class="text-gray-400 hover:text-gray-100 transition-colors"
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

						<div>
							<label class="block text-sm text-gray-400 mb-1">Room Name</label>
							<input
								type="text"
								value={newRoomName}
								onInput={(e) => setNewRoomName((e.target as HTMLInputElement).value)}
								placeholder="e.g., Website Development"
								class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 text-sm"
							/>
						</div>

						<div>
							<label class="block text-sm text-gray-400 mb-1">Description (optional)</label>
							<textarea
								value={newRoomDescription}
								onInput={(e) => setNewRoomDescription((e.target as HTMLTextAreaElement).value)}
								placeholder="What will this room be used for?"
								rows={2}
								class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none text-sm"
							/>
						</div>

						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={handleCreateRoom}
							disabled={!newRoomName.trim() || submitting}
							fullWidth
						>
							Create Room
						</Button>
					</div>
				)}

				{/* Action Buttons */}
				<div class="flex gap-3 pt-2">
					<Button type="button" variant="secondary" onClick={handleClose} fullWidth>
						Cancel
					</Button>
					<Button type="submit" loading={submitting} disabled={!selectedPath.trim()} fullWidth>
						Create Session
					</Button>
				</div>
			</form>
		</Modal>
	);
}
