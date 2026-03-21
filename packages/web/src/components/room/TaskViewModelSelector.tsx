/**
 * TaskViewModelSelector Component
 *
 * Provides a compact model selector dropdown for use in the TaskView info panel.
 * Allows switching between available models grouped by provider.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ModelInfo } from '@neokai/shared';
import type { ProviderAuthStatus } from '@neokai/shared/provider';
import { connectionManager } from '../../lib/connection-manager';
import { toast } from '../../lib/toast.ts';
import {
	groupModelsByProvider,
	filterModelsForPicker,
	getModelFamilyIcon,
	mapRawModelsToModelInfos,
	PROVIDER_LABELS,
} from '../../hooks/useModelSwitcher.ts';
import { Spinner } from '../ui/Spinner';
import { listProviderAuthStatus } from '../../lib/api-helpers.ts';

interface RawModelEntry {
	id: string;
	display_name: string;
	description: string;
	alias?: string;
	provider?: string;
}

export interface TaskViewModelSelectorProps {
	sessionId: string;
	currentModel: string;
	currentProvider?: string;
	disabled?: boolean;
	/** Called after a model switch succeeds, with the new model ID */
	onModelSwitched?: (model: string, provider: string) => void;
}

export function TaskViewModelSelector({
	sessionId,
	currentModel,
	currentProvider,
	disabled = false,
	onModelSwitched,
}: TaskViewModelSelectorProps) {
	const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
	const [providerAuthStatuses, setProviderAuthStatuses] = useState<Map<string, ProviderAuthStatus>>(
		new Map()
	);
	const [loading, setLoading] = useState(true);
	const [switching, setSwitching] = useState(false);
	const [dropdownOpen, setDropdownOpen] = useState(false);

	// Fetch available models and provider auth statuses
	useEffect(() => {
		const fetchData = async () => {
			setLoading(true);
			try {
				const hub = connectionManager.getHubIfConnected();
				if (!hub) return;

				// Fetch models and auth status in parallel
				const [modelsResponse, authResponse] = await Promise.all([
					hub.request('models.list', { useCache: true }) as Promise<{ models: RawModelEntry[] }>,
					listProviderAuthStatus().catch(() => ({ providers: [] as ProviderAuthStatus[] })),
				]);

				setAvailableModels(mapRawModelsToModelInfos(modelsResponse.models));

				// Build auth status map
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

	// Switch model handler
	const switchModel = useCallback(
		async (model: ModelInfo) => {
			if (!model.provider) {
				toast.error('Model provider information is missing');
				return;
			}

			setDropdownOpen(false);
			setSwitching(true);

			try {
				const hub = connectionManager.getHubIfConnected();
				if (!hub) {
					toast.error('Not connected to server');
					return;
				}

				const result = (await hub.request('session.model.switch', {
					sessionId,
					model: model.id,
					provider: model.provider,
				})) as {
					success: boolean;
					model: string;
					error?: string;
				};

				if (result.success) {
					toast.success(`Switched to ${model.name}`);
					onModelSwitched?.(model.id, model.provider ?? '');
				} else {
					toast.error(result.error || 'Failed to switch model');
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Failed to switch model';
				toast.error(errorMessage);
			} finally {
				setSwitching(false);
			}
		},
		[sessionId]
	);

	// Get current model info
	const currentModelInfo =
		availableModels.find((m) => m.id === currentModel && m.provider === currentProvider) ??
		availableModels.find((m) => m.id === currentModel);

	const filteredModels = filterModelsForPicker(
		availableModels,
		providerAuthStatuses,
		currentProvider
	);
	const groupedModels = groupModelsByProvider(filteredModels);

	const handleToggleDropdown = () => {
		if (!disabled && !loading) {
			setDropdownOpen((open) => !open);
		}
	};

	return (
		<div class="relative inline-block">
			<button
				class={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${
					disabled
						? 'text-gray-500 cursor-not-allowed'
						: 'text-blue-400 hover:text-blue-300 hover:bg-dark-700 cursor-pointer'
				}`}
				onClick={handleToggleDropdown}
				disabled={disabled || loading}
				title="Click to switch model"
			>
				{loading || switching ? (
					<Spinner size="xs" />
				) : (
					<>
						<span>{currentModelInfo ? getModelFamilyIcon(currentModelInfo.family) : '💎'}</span>
						<span class="max-w-[120px] truncate">
							{currentModelInfo?.name || currentModel || 'Unknown'}
						</span>
						<svg
							class={`w-3 h-3 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`}
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
					</>
				)}
			</button>

			{dropdownOpen && (
				<div class="absolute left-0 top-full mt-1 bg-dark-800 border border-dark-600 rounded-lg shadow-xl w-56 max-h-64 overflow-y-auto z-50 animate-slideIn">
					<div class="py-1">
						{Array.from(groupedModels.entries()).map(([provider, models]) => {
							const authStatus = providerAuthStatuses.get(provider);
							const isAuthenticated = authStatus?.isAuthenticated ?? false;
							const needsRefresh = authStatus?.needsRefresh ?? false;

							return (
								<div key={provider}>
									{/* Provider header */}
									<div class="px-3 py-1.5 text-xs font-semibold text-gray-400 flex items-center gap-2 sticky top-0 bg-dark-800">
										<span>{PROVIDER_LABELS[provider] || provider}</span>
										{!isAuthenticated && (
											<span class="text-xs text-gray-600">(not authenticated)</span>
										)}
										{needsRefresh && <span class="text-xs text-yellow-500">(needs refresh)</span>}
									</div>

									{/* Models for this provider */}
									{models.map((model) => {
										const isCurrent =
											model.id === currentModelInfo?.id &&
											model.provider === currentModelInfo?.provider;

										return (
											<button
												key={`${model.provider}:${model.id}`}
												class={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
													isCurrent
														? 'text-blue-400 bg-dark-700/50'
														: 'text-gray-200 hover:bg-dark-700'
												}`}
												onClick={() => switchModel(model)}
												disabled={switching}
											>
												<span class="text-base">{getModelFamilyIcon(model.family)}</span>
												<span class="flex-1 truncate">{model.name}</span>
												{isCurrent && <span class="text-blue-400 text-[10px]">✓</span>}
											</button>
										);
									})}
								</div>
							);
						})}

						{filteredModels.length === 0 && (
							<div class="px-3 py-2 text-xs text-gray-500">No models available</div>
						)}
					</div>
				</div>
			)}

			{/* Click outside handler */}
			{dropdownOpen && <div class="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />}
		</div>
	);
}
