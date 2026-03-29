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
	defaultLabel?: string;
	className?: string;
}

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
	defaultLabel = 'Use agent default',
	className = 'w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500',
}: WorkflowModelSelectProps) {
	const [models, setModels] = useState<ModelInfo[]>([]);

	useEffect(() => {
		let cancelled = false;

		async function loadModels() {
			try {
				const hub = connectionManager.getHubIfConnected();
				if (!hub) return;
				const response = (await hub.request('models.list', {
					useCache: true,
				})) as { models: RawModelEntry[] };
				if (cancelled) return;
				setModels(dedupeModelsById(mapRawModelsToModelInfos(response.models ?? [])));
			} catch {
				if (!cancelled) setModels([]);
			}
		}

		void loadModels();
		return () => {
			cancelled = true;
		};
	}, []);

	const groupedModels = useMemo(() => groupModelsByProvider(models), [models]);
	const hasCurrentOutsideList = !!value && !models.some((model) => model.id === value);

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
			<option value="">{defaultLabel}</option>
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
