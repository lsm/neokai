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
	onSubmit: (params: { roomId?: string; model?: ModelInfo }) => Promise<void>;
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
	rooms,
	onCreateRoom,
}: NewSessionModalProps) {
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

		// Clear stale picker data immediately so the modal never shows previous results
		// while the fresh auth check is still pending.
		setAvailableModels([]);
		setProviderAuthStatuses(new Map());

		let cancelled = false;

		// Fetch both together so a failure in either suppresses the model picker atomically.
		// If auth status cannot be determined we must not show unfiltered models.
		Promise.all([fetchAvailableModels(), fetchProviderAuthStatuses()])
			.then(([models, statuses]) => {
				if (cancelled) return;
				setAvailableModels(models);
				setProviderAuthStatuses(statuses);
			})
			.catch(() => {
				// Either models or auth unavailable — keep model picker hidden.
				// No state update needed: already cleared at effect start.
			});

		return () => {
			cancelled = true;
		};
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

		try {
			setSubmitting(true);
			setError(null);

			await onSubmit({
				roomId: selectedRoomId || undefined,
				model: resolveSelectedModel(),
			});

			// Reset form on success
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

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="New Session" size="md">
			<form onSubmit={handleSubmit} class="space-y-5">
				{error && (
					<div class="bg-red-900/20 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
						{error}
					</div>
				)}

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
					<Button type="submit" loading={submitting} disabled={submitting} fullWidth>
						Create Session
					</Button>
				</div>
			</form>
		</Modal>
	);
}
