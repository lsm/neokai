/**
 * FallbackModelsSettings Component
 *
 * Allows configuring the fallback model chain for automatic model switching
 * when rate limits or usage limits are hit.
 */

import { useEffect, useState } from 'preact/hooks';
import type { FallbackModelEntry, ModelInfo } from '@neokai/shared';
import type { ProviderAuthStatus } from '@neokai/shared/provider';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { connectionManager } from '../../lib/connection-manager';
import {
	groupModelsByProvider,
	filterModelsForPicker,
	getModelFamilyIcon,
	mapRawModelsToModelInfos,
	PROVIDER_LABELS,
} from '../../hooks/useModelSwitcher.ts';
import { SettingsSection } from './SettingsSection.tsx';
import { Spinner } from '../ui/Spinner';
import { listProviderAuthStatus } from '../../lib/api-helpers.ts';

interface RawModelEntry {
	id: string;
	display_name: string;
	description: string;
	alias?: string;
	provider?: string;
}

export function FallbackModelsSettings() {
	const settings = globalSettings.value;
	const [fallbackModels, setFallbackModels] = useState<FallbackModelEntry[]>(
		settings?.fallbackModels ?? []
	);
	const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
	const [providerAuthStatuses, setProviderAuthStatuses] = useState<Map<string, ProviderAuthStatus>>(
		new Map()
	);
	const [loading, setLoading] = useState(true);
	const [isUpdating, setIsUpdating] = useState(false);
	const [showAddModal, setShowAddModal] = useState(false);

	// Sync with global settings when they change
	useEffect(() => {
		if (settings) {
			setFallbackModels(settings.fallbackModels ?? []);
		}
	}, [settings]);

	// Fetch available models
	useEffect(() => {
		const fetchData = async () => {
			setLoading(true);
			try {
				const hub = connectionManager.getHubIfConnected();
				if (!hub) return;

				const [modelsResponse, authResponse] = await Promise.all([
					hub.request('models.list', { useCache: true }) as Promise<{ models: RawModelEntry[] }>,
					listProviderAuthStatus().catch(() => ({ providers: [] })),
				]);

				setAvailableModels(mapRawModelsToModelInfos(modelsResponse.models));

				const authMap = new Map<string, ProviderAuthStatus>();
				for (const p of authResponse.providers) {
					authMap.set(p.id, p);
				}
				setProviderAuthStatuses(authMap);
			} catch {
				// Error handled silently
			} finally {
				setLoading(false);
			}
		};

		void fetchData();
	}, []);

	// Save fallback models to settings
	const saveFallbackModels = async (models: FallbackModelEntry[]) => {
		setIsUpdating(true);
		try {
			await updateGlobalSettings({ fallbackModels: models });
			setFallbackModels(models);
			toast.success('Fallback models updated');
		} catch {
			toast.error('Failed to update fallback models');
		} finally {
			setIsUpdating(false);
		}
	};

	// Remove a fallback model
	const handleRemove = async (index: number) => {
		const newModels = [...fallbackModels];
		newModels.splice(index, 1);
		await saveFallbackModels(newModels);
	};

	// Move a fallback model up or down
	const handleMove = async (index: number, direction: 'up' | 'down') => {
		const newIndex = direction === 'up' ? index - 1 : index + 1;
		if (newIndex < 0 || newIndex >= fallbackModels.length) return;

		const newModels = [...fallbackModels];
		[newModels[index], newModels[newIndex]] = [newModels[newIndex], newModels[index]];
		await saveFallbackModels(newModels);
	};

	// Add a new fallback model
	const handleAdd = async (model: ModelInfo) => {
		// Check if model is already in the list
		if (fallbackModels.some((m) => m.model === model.id && m.provider === model.provider)) {
			toast.error('Model is already in the fallback chain');
			return;
		}

		const newModels = [
			...fallbackModels,
			{ model: model.id, provider: model.provider ?? 'anthropic' },
		];
		await saveFallbackModels(newModels);
		setShowAddModal(false);
	};

	// Get model info for display
	const getModelDisplayInfo = (entry: FallbackModelEntry): { name: string; family: string } => {
		const model = availableModels.find(
			(m) => m.id === entry.model && m.provider === entry.provider
		);
		return {
			name: model?.name ?? entry.model,
			family: model?.family ?? 'sonnet',
		};
	};

	const filteredModels = filterModelsForPicker(availableModels, providerAuthStatuses, undefined);
	const groupedModels = groupModelsByProvider(filteredModels);

	return (
		<SettingsSection title="Fallback Models">
			<div class="space-y-3">
				<p class="text-xs text-gray-500 mb-3">
					Configure an ordered list of fallback models. When the primary model hits a rate limit or
					usage limit, NeoKai will automatically switch to the next model in the chain.
				</p>

				{loading ? (
					<div class="flex items-center gap-2 text-xs text-gray-500">
						<Spinner size="xs" />
						<span>Loading models...</span>
					</div>
				) : fallbackModels.length === 0 ? (
					<div class="text-xs text-gray-500 italic">No fallback models configured</div>
				) : (
					<div class="space-y-2">
						{fallbackModels.map((entry, index) => {
							const displayInfo = getModelDisplayInfo(entry);
							return (
								<div
									key={`${entry.provider}:${entry.model}`}
									class="flex items-center gap-2 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2"
								>
									{/* Priority number */}
									<span class="text-xs text-gray-500 font-medium w-4">{index + 1}.</span>

									{/* Model icon */}
									<span class="text-base">{getModelFamilyIcon(displayInfo.family)}</span>

									{/* Model name and provider */}
									<div class="flex-1 min-w-0">
										<div class="text-sm text-gray-200 truncate">{displayInfo.name}</div>
										<div class="text-xs text-gray-500">
											{PROVIDER_LABELS[entry.provider] || entry.provider}
										</div>
									</div>

									{/* Move buttons */}
									<div class="flex items-center gap-1">
										<button
											class="p-1 rounded hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed"
											onClick={() => handleMove(index, 'up')}
											disabled={index === 0 || isUpdating}
											title="Move up"
										>
											<svg
												class="w-4 h-4 text-gray-400"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M5 15l7-7 7 7"
												/>
											</svg>
										</button>
										<button
											class="p-1 rounded hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed"
											onClick={() => handleMove(index, 'down')}
											disabled={index === fallbackModels.length - 1 || isUpdating}
											title="Move down"
										>
											<svg
												class="w-4 h-4 text-gray-400"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M19 9l-7 7-7-7"
												/>
											</svg>
										</button>
									</div>

									{/* Remove button */}
									<button
										class="p-1 rounded hover:bg-red-900/30 disabled:opacity-30 disabled:cursor-not-allowed"
										onClick={() => handleRemove(index)}
										disabled={isUpdating}
										title="Remove"
									>
										<svg
											class="w-4 h-4 text-red-400"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M6 18L18 6M6 6l12 12"
											/>
										</svg>
									</button>
								</div>
							);
						})}
					</div>
				)}

				{/* Add button */}
				<button
					class="flex items-center gap-2 px-3 py-2 text-sm text-blue-400 hover:text-blue-300 hover:bg-dark-800 rounded-lg border border-dashed border-dark-600 hover:border-dark-500 transition-colors disabled:opacity-50"
					onClick={() => setShowAddModal(true)}
					disabled={loading}
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 4v16m8-8H4"
						/>
					</svg>
					Add Fallback Model
				</button>
			</div>

			{/* Add Model Modal */}
			{showAddModal && (
				<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
					<div class="bg-dark-850 border border-dark-600 rounded-lg shadow-xl w-80 max-h-[80vh] overflow-hidden flex flex-col">
						<div class="flex items-center justify-between px-4 py-3 border-b border-dark-700">
							<h3 class="text-sm font-medium text-gray-100">Add Fallback Model</h3>
							<button class="p-1 rounded hover:bg-dark-700" onClick={() => setShowAddModal(false)}>
								<svg
									class="w-4 h-4 text-gray-400"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
							</button>
						</div>

						<div class="flex-1 overflow-y-auto py-2">
							{Array.from(groupedModels.entries()).map(([provider, models]) => {
								const authStatus = providerAuthStatuses.get(provider);
								const isAuthenticated = authStatus?.isAuthenticated ?? false;

								return (
									<div key={provider}>
										<div class="px-4 py-1.5 text-xs font-semibold text-gray-400">
											{PROVIDER_LABELS[provider] || provider}
											{!isAuthenticated && (
												<span class="text-gray-600 ml-1">(not authenticated)</span>
											)}
										</div>
										{models.map((model) => {
											// Don't show models already in fallback chain
											if (
												fallbackModels.some(
													(m) => m.model === model.id && m.provider === model.provider
												)
											) {
												return null;
											}

											return (
												<button
													key={`${model.provider}:${model.id}`}
													class="w-full text-left px-4 py-2 text-sm flex items-center gap-2 hover:bg-dark-700 transition-colors"
													onClick={() => handleAdd(model)}
												>
													<span class="text-base">{getModelFamilyIcon(model.family)}</span>
													<span class="flex-1 text-gray-200 truncate">{model.name}</span>
												</button>
											);
										})}
									</div>
								);
							})}

							{filteredModels.filter(
								(m) => !fallbackModels.some((f) => f.model === m.id && f.provider === m.provider)
							).length === 0 && (
								<div class="px-4 py-4 text-sm text-gray-500 text-center">
									All available models are already in the fallback chain
								</div>
							)}
						</div>
					</div>
				</div>
			)}
		</SettingsSection>
	);
}
