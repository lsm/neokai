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
import type { ModelInfo } from '@liuboer/shared';
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
	switchModel: (modelId: string) => Promise<void>;
	/** Reload model info */
	reload: () => Promise<void>;
}

/** Model family icons for visual hierarchy */
export const MODEL_FAMILY_ICONS: Record<string, string> = {
	opus: '🧠',
	sonnet: '💎',
	haiku: '⚡',
	glm: '🌐',
	// Default icon for unknown families
	__default__: '💎',
};

/** Model family sort order */
const FAMILY_ORDER: Record<string, number> = {
	opus: 0,
	sonnet: 1,
	haiku: 2,
	glm: 3,
};

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
			const { currentModel: modelId, modelInfo } = (await hub.call('session.model.get', {
				sessionId,
			})) as {
				currentModel: string;
				modelInfo: ModelInfo | null;
			};

			setCurrentModel(modelId);
			setCurrentModelInfo(modelInfo);

			// Fetch available models
			const { models } = (await hub.call('models.list', {
				useCache: true,
			})) as {
				models: Array<{
					id: string;
					display_name: string;
					description: string;
				}>;
			};

			const modelInfos: ModelInfo[] = models.map((m) => {
				let family: 'opus' | 'sonnet' | 'haiku' | 'glm' = 'sonnet';
				let provider: 'anthropic' | 'glm' = 'anthropic';

				if (m.id.includes('opus')) family = 'opus';
				else if (m.id.includes('haiku')) family = 'haiku';
				else if (m.id.toLowerCase().startsWith('glm-')) {
					family = 'glm';
					provider = 'glm';
				}

				return {
					id: m.id,
					name: m.display_name,
					alias: m.id.split('-').pop() || m.id,
					family,
					provider,
					contextWindow: 200000,
					description: m.description || '',
					releaseDate: '',
					available: true,
				};
			});

			// Sort by family order
			modelInfos.sort((a, b) => FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family]);
			setAvailableModels(modelInfos);
		} catch (error) {
			console.error('Failed to load model info:', error);
		} finally {
			setLoading(false);
		}
	}, [sessionId]);

	// Load on mount and session change
	useEffect(() => {
		loadModelInfo();
	}, [loadModelInfo]);

	const switchModel = useCallback(
		async (newModelId: string) => {
			if (newModelId === currentModel) {
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

				const result = (await hub.call('session.model.switch', {
					sessionId,
					model: newModelId,
				})) as {
					success: boolean;
					model: string;
					error?: string;
				};

				if (result.success) {
					setCurrentModel(result.model);
					const newModelInfo = availableModels.find((m) => m.id === result.model);
					setCurrentModelInfo(newModelInfo || null);
					toast.success(`Switched to ${newModelInfo?.name || result.model}`);
				} else {
					toast.error(result.error || 'Failed to switch model');
				}
			} catch (error) {
				console.error('Model switch error:', error);
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
