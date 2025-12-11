import { useEffect, useState } from 'preact/hooks';
import { cn } from '../lib/utils.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { Dropdown } from './ui/Dropdown.tsx';
import type { ModelInfo } from '@liuboer/shared';

interface ModelSwitcherProps {
	sessionId: string;
	disabled?: boolean;
}

/**
 * Model family icons for visual hierarchy
 */
const MODEL_FAMILY_ICONS = {
	opus: '🎯',
	sonnet: '⚡',
	haiku: '🚀',
} as const;

/**
 * Model family descriptions
 */
const MODEL_FAMILY_LABELS = {
	opus: 'Opus - Most Capable',
	sonnet: 'Sonnet - Balanced',
	haiku: 'Haiku - Fast & Efficient',
} as const;

export function ModelSwitcher({ sessionId, disabled }: ModelSwitcherProps) {
	const [currentModel, setCurrentModel] = useState<string>('');
	const [currentModelInfo, setCurrentModelInfo] = useState<ModelInfo | null>(null);
	const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
	const [switching, setSwitching] = useState(false);
	const [loading, setLoading] = useState(true);
	const [isOpen, setIsOpen] = useState(false);

	// Fetch current model and available models on mount
	useEffect(() => {
		loadModelInfo();
	}, [sessionId]);

	const loadModelInfo = async () => {
		try {
			setLoading(true);
			const hub = await connectionManager.getHub();

			// Fetch current model
			const { currentModel: modelId, modelInfo } = (await hub.call('session.model.get', {
				sessionId,
			})) as {
				currentModel: string;
				modelInfo: ModelInfo | null;
			};

			setCurrentModel(modelId);
			setCurrentModelInfo(modelInfo);

			// Fetch available models (uses SDK's supportedModels())
			const { models } = (await hub.call('models.list', {
				useCache: true,
			})) as {
				models: Array<{ id: string; display_name: string; description: string }>;
			};

			// Convert to ModelInfo format (simplified - we'll group by name patterns)
			const modelInfos: ModelInfo[] = models.map((m) => {
				// Determine family from model ID
				let family: 'opus' | 'sonnet' | 'haiku' = 'sonnet';
				if (m.id.includes('opus')) family = 'opus';
				else if (m.id.includes('haiku')) family = 'haiku';

				return {
					id: m.id,
					name: m.display_name,
					alias: m.id.split('-').pop() || m.id,
					family,
					contextWindow: 200000,
					description: m.description || '',
					releaseDate: '',
					available: true,
				};
			});

			setAvailableModels(modelInfos);
		} catch (error) {
			console.error('Failed to load model info:', error);
			toast.error('Failed to load model information');
		} finally {
			setLoading(false);
		}
	};

	const handleModelSwitch = async (newModelId: string) => {
		if (newModelId === currentModel) {
			toast.info(`Already using ${currentModelInfo?.name || currentModel}`);
			setIsOpen(false);
			return;
		}

		try {
			setSwitching(true);

			const hub = await connectionManager.getHub();
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
				setIsOpen(false); // Close dropdown after successful switch
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
	};

	// Group models by family
	const modelsByFamily = availableModels.reduce(
		(acc, model) => {
			if (!acc[model.family]) {
				acc[model.family] = [];
			}
			acc[model.family].push(model);
			return acc;
		},
		{} as Record<string, ModelInfo[]>
	);

	// Build dropdown content - one model per line with checkmark for current
	const dropdownContent = (
		<div
			class="py-2 bg-dark-850 border border-dark-700 rounded-lg min-w-[220px] max-h-[400px] overflow-y-auto"
			data-testid="model-switcher-dropdown"
		>
			{(['opus', 'sonnet', 'haiku'] as const).map((family) => {
				const models = modelsByFamily[family];
				if (!models || models.length === 0) return null;

				return (
					<div key={family} class="mb-1 last:mb-0">
						{/* Family header */}
						<div class="px-3 py-1.5 text-[10px] text-gray-500 uppercase tracking-wider font-medium flex items-center gap-1.5">
							<span>{MODEL_FAMILY_ICONS[family]}</span>
							<span>{MODEL_FAMILY_LABELS[family]}</span>
						</div>
						{/* Models in this family */}
						{models.map((model) => {
							const isCurrent = model.id === currentModel;

							return (
								<button
									key={model.id}
									onClick={(e) => {
										e.stopPropagation();
										handleModelSwitch(model.id);
									}}
									disabled={switching}
									data-testid={`model-option-${model.family}`}
									data-model-id={model.id}
									class={cn(
										'w-full px-3 py-2 text-left text-sm flex items-center justify-between transition-colors',
										isCurrent
											? 'text-white bg-blue-600/20'
											: 'text-gray-300 hover:bg-dark-700/50 hover:text-white',
										switching && 'opacity-50 cursor-not-allowed'
									)}
								>
									<span class="truncate">{model.name}</span>
									{isCurrent && (
										<svg
											class="w-4 h-4 text-blue-400 flex-shrink-0 ml-2"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
											data-testid="current-model-checkmark"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2.5}
												d="M5 13l4 4L19 7"
											/>
										</svg>
									)}
								</button>
							);
						})}
					</div>
				);
			})}
		</div>
	);

	if (loading) {
		return (
			<button
				type="button"
				disabled
				class="px-3 py-2 rounded-lg text-sm text-gray-500 bg-dark-800/50 border border-dark-700/50 flex items-center gap-2"
				data-testid="model-switcher-loading"
			>
				<div class="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
				<span>Loading...</span>
			</button>
		);
	}

	return (
		<Dropdown
			trigger={
				<button
					type="button"
					disabled={disabled || switching}
					data-testid="model-switcher-button"
					class={cn(
						'px-3 py-2 rounded-lg text-sm transition-all flex items-center gap-2',
						disabled || switching
							? 'text-gray-600 bg-dark-800/30 border border-dark-700/30 cursor-not-allowed'
							: 'text-gray-300 bg-dark-800/50 border border-dark-700/50 hover:bg-dark-800 hover:border-dark-700 hover:text-gray-100'
					)}
					title="Switch Claude model"
				>
					{switching ? (
						<>
							<div class="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
							<span>Switching...</span>
						</>
					) : currentModelInfo ? (
						<>
							<span class="text-base leading-none">
								{MODEL_FAMILY_ICONS[currentModelInfo.family]}
							</span>
							<span>{currentModelInfo.name}</span>
							<svg
								class="w-4 h-4 text-gray-400"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M19 9l-7 7-7-7"
								/>
							</svg>
						</>
					) : (
						<span>Select Model</span>
					)}
				</button>
			}
			items={[]} // We use customContent instead
			customContent={dropdownContent}
			position="left"
			isOpen={isOpen}
			onOpenChange={setIsOpen}
		/>
	);
}
