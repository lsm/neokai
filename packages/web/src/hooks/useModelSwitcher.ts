/**
 * useModelSwitcher Hook
 *
 * Manages model information loading and switching for a session.
 * Handles fetching current model, available models list, and switching logic.
 *
 * @example
 * ```typescript
 * const {
 *   currentModel,
 *   currentModelInfo,
 *   availableModels,
 *   switching,
 *   loading,
 *   switchModel,
 * } = useModelSwitcher(sessionId);
 * ```
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import type { ModelInfo } from '@neokai/shared';
import { connectionManager } from '../lib/connection-manager';
import { toast } from '../lib/toast';

export interface UseModelSwitcherResult {
	/** Current model ID */
	currentModel: string;
	/** Current model info (null if not loaded) */
	currentModelInfo: ModelInfo | null;
	/** List of available models */
	availableModels: ModelInfo[];
	/** Whether a model switch is in progress */
	switching: boolean;
	/** Whether models are being loaded */
	loading: boolean;
	/** Switch to a different model */
	switchModel: (model: ModelInfo) => Promise<void>;
	/** Reload model info */
	reload: () => Promise<void>;
}

/** Model family icons for visual hierarchy */
export const MODEL_FAMILY_ICONS: Record<string, string> = {
	opus: '🧠',
	sonnet: '💎',
	haiku: '⚡',
	glm: '🌐',
	minimax: '🔥',
	gpt: '🔮',
	gemini: '✨',
	// Default icon for unknown families
	__default__: '💎',
};

/**
 * Get the icon for a model family with fallback to default
 */
export function getModelFamilyIcon(family: string): string {
	return MODEL_FAMILY_ICONS[family] || MODEL_FAMILY_ICONS.__default__;
}

/** Model family sort order */
const FAMILY_ORDER: Record<string, number> = {
	opus: 0,
	sonnet: 1,
	haiku: 2,
	glm: 3,
	minimax: 4,
	gpt: 5,
	gemini: 6,
};

/** Provider sort order for model picker grouping */
const PROVIDER_ORDER: Record<string, number> = {
	anthropic: 0,
	'anthropic-copilot': 1,
	'anthropic-codex': 2,
	glm: 3,
	minimax: 4,
};

/**
 * Group models by their provider, preserving insertion order of the input array.
 * Provider group ordering depends on the caller supplying a pre-sorted array —
 * `loadModelInfo` sorts by PROVIDER_ORDER before calling this function.
 * Models within each group retain their input order (family-sorted by the caller).
 */
export function groupModelsByProvider(models: ModelInfo[]): Map<string, ModelInfo[]> {
	const groups = new Map<string, ModelInfo[]>();
	for (const model of models) {
		const provider = model.provider || 'anthropic';
		const existing = groups.get(provider);
		if (existing) {
			existing.push(model);
		} else {
			groups.set(provider, [model]);
		}
	}
	return groups;
}

/** Provider display labels for UI */
export const PROVIDER_LABELS: Record<string, string> = {
	anthropic: 'Anthropic',
	glm: 'GLM',
	minimax: 'MiniMax',
	'anthropic-copilot': 'Copilot',
	'anthropic-codex': 'Codex',
	// Note: keep in sync with PROVIDER_ORDER above
};

/**
 * Get the display label for a provider
 */
export function getProviderLabel(provider: string): string {
	return PROVIDER_LABELS[provider] || provider;
}

/**
 * Hook for managing model switching
 *
 * @param sessionId - Current session ID
 */
export function useModelSwitcher(sessionId: string): UseModelSwitcherResult {
	const [currentModel, setCurrentModel] = useState<string>('');
	const [currentModelInfo, setCurrentModelInfo] = useState<ModelInfo | null>(null);
	const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
	const [switching, setSwitching] = useState(false);
	const [loading, setLoading] = useState(true);

	const loadModelInfo = useCallback(async () => {
		try {
			setLoading(true);
			const hub = connectionManager.getHubIfConnected();
			if (!hub) return;

			// Fetch current model
			const { currentModel: modelId, modelInfo } = (await hub.request('session.model.get', {
				sessionId,
			})) as {
				currentModel: string;
				modelInfo: ModelInfo | null;
			};

			setCurrentModel(modelId);
			setCurrentModelInfo(modelInfo);

			// Fetch available models (includes all providers for cross-provider switching)
			const { models } = (await hub.request('models.list', {
				useCache: true,
			})) as {
				models: Array<{
					id: string;
					display_name: string;
					description: string;
					alias?: string;
					provider?: string;
				}>;
			};

			const modelInfos: ModelInfo[] = models.map((m) => {
				// Determine family from model ID
				let family: string = 'sonnet';
				const modelId = m.id.toLowerCase();
				if (modelId.includes('opus')) {
					family = 'opus';
				} else if (modelId.includes('haiku')) {
					family = 'haiku';
				} else if (modelId.startsWith('glm-')) {
					family = 'glm';
				} else if (modelId.startsWith('minimax-')) {
					family = 'minimax';
				} else if (modelId.startsWith('gpt-')) {
					family = 'gpt';
				} else if (modelId.startsWith('gemini-')) {
					family = 'gemini';
				}

				return {
					id: m.id,
					name: m.display_name,
					// Use server-provided alias (unique per provider, e.g. 'copilot-anthropic-sonnet' for Copilot bridge)
					alias: m.alias || m.id,
					family,
					// Use server-provided provider for correct routing
					provider: m.provider || 'anthropic',
					contextWindow: 200000,
					description: m.description || '',
					releaseDate: '',
					available: true,
				};
			});

			// Sort by provider first, then by family order within each provider group.
			// This pre-sort is required so that groupModelsByProvider() preserves
			// the intended provider order via Map insertion order.
			modelInfos.sort((a, b) => {
				const providerA = PROVIDER_ORDER[a.provider || 'anthropic'] ?? 99;
				const providerB = PROVIDER_ORDER[b.provider || 'anthropic'] ?? 99;
				if (providerA !== providerB) return providerA - providerB;
				const familyA = FAMILY_ORDER[a.family] ?? 99;
				const familyB = FAMILY_ORDER[b.family] ?? 99;
				return familyA - familyB;
			});
			setAvailableModels(modelInfos);
		} catch {
			// Error handled silently - loading state will be cleared
		} finally {
			setLoading(false);
		}
	}, [sessionId]);

	// Load on mount and session change
	useEffect(() => {
		loadModelInfo();
	}, [loadModelInfo]);

	const switchModel = useCallback(
		async (model: ModelInfo) => {
			if (!model.provider) {
				toast.error('Model provider information is missing');
				return;
			}

			if (model.id === currentModel && model.provider === currentModelInfo?.provider) {
				toast.info(`Already using ${currentModelInfo?.name || currentModel}`);
				return;
			}

			try {
				setSwitching(true);
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
					setCurrentModel(result.model);
					// Match by both id AND provider to avoid returning the wrong entry when
					// two providers share the same canonical model ID (e.g. anthropic and
					// anthropic-copilot both expose claude-sonnet-4.6).
					const newModelInfo =
						availableModels.find((m) => m.id === result.model && m.provider === model.provider) ??
						availableModels.find((m) => m.id === result.model);
					setCurrentModelInfo(newModelInfo || null);
					toast.success(`Switched to ${newModelInfo?.name || result.model}`);
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
		[sessionId, currentModel, currentModelInfo, availableModels]
	);

	return {
		currentModel,
		currentModelInfo,
		availableModels,
		switching,
		loading,
		switchModel,
		reload: loadModelInfo,
	};
}
