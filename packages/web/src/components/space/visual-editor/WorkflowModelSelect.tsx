import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ModelInfo } from '@neokai/shared';
import { connectionManager } from '../../../lib/connection-manager';
import {
	groupModelsByProvider,
	mapRawModelsToModelInfos,
	PROVIDER_LABELS,
	type RawModelEntry,
} from '../../../hooks/useModelSwitcher';

interface WorkflowModelSelectProps {
	value?: string;
	onChange: (value: string | undefined) => void;
	testId: string;
	className?: string;
}

type LoadState = 'loading' | 'ready' | 'no-providers';

function dedupeModelsById(models: ModelInfo[]): ModelInfo[] {
	const seen = new Set<string>();
	const deduped: ModelInfo[] = [];
	for (const model of models) {
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		deduped.push(model);
	}
	return deduped;
}

export function WorkflowModelSelect({
	value,
	onChange,
	testId,
	className = 'w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed',
}: WorkflowModelSelectProps) {
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [loadState, setLoadState] = useState<LoadState>('loading');

	useEffect(() => {
		let cancelled = false;

		async function loadModels() {
			try {
				const hub = await connectionManager.getHub();
				if (cancelled) return;
				const response = (await hub.request('models.list', {
					useCache: true,
				})) as { models: RawModelEntry[] };
				if (cancelled) return;
				const loaded = dedupeModelsById(mapRawModelsToModelInfos(response.models ?? []));
				setModels(loaded);
				setLoadState(loaded.length > 0 ? 'ready' : 'no-providers');
			} catch {
				if (!cancelled) {
					setModels([]);
					setLoadState('no-providers');
				}
			}
		}

		void loadModels();
		return () => {
			cancelled = true;
		};
	}, []);

	const groupedModels = useMemo(() => groupModelsByProvider(models), [models]);
	const hasCurrentOutsideList = !!value && !models.some((model) => model.id === value);

	if (loadState === 'loading') {
		return (
			<select data-testid={testId} disabled class={className}>
				<option>Loading models…</option>
			</select>
		);
	}

	if (loadState === 'no-providers') {
		return (
			<select data-testid={testId} disabled class={className}>
				<option>No providers available</option>
			</select>
		);
	}

	// Native select remains intentionally simple here because OpenRouter is capped server-side;
	// the primary status-bar and fallback settings pickers provide searchable custom menus.
	return (
		<select
			data-testid={testId}
			value={value ?? ''}
			onChange={(e) => {
				const nextValue = (e.currentTarget as HTMLSelectElement).value;
				onChange(nextValue || undefined);
			}}
			class={className}
		>
			<option value="">— No override —</option>
			{hasCurrentOutsideList && <option value={value}>{`Current (${value})`}</option>}
			{Array.from(groupedModels.entries()).map(([provider, providerModels]) => (
				<optgroup key={provider} label={PROVIDER_LABELS[provider] || provider}>
					{providerModels.map((model) => (
						<option key={`${provider}:${model.id}`} value={model.id}>
							{`${model.name} (${model.id})`}
						</option>
					))}
				</optgroup>
			))}
		</select>
	);
}
