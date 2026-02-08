/**
 * SettingSourcesSection - Settings source configuration
 *
 * Configure which settings sources to load from.
 */

import type { GlobalSettings, SettingSource } from '@neokai/shared';
import { SettingToggle } from '../../shared/SettingToggle.tsx';
import { updateGlobalSettings } from '../../../../lib/api-helpers.ts';
import { toast } from '../../../../lib/toast.ts';

export interface SettingSourcesSectionProps {
	settings: GlobalSettings | null;
}

const SETTING_SOURCE_OPTIONS: Array<{
	value: SettingSource;
	label: string;
	description: string;
}> = [
	{
		value: 'user',
		label: 'User',
		description: 'Load settings from ~/.claude/',
	},
	{
		value: 'project',
		label: 'Project',
		description: 'Load settings from .claude/ in workspace',
	},
	{
		value: 'local',
		label: 'Local',
		description: 'Load settings from .claude/settings.local.json',
	},
];

export function SettingSourcesSection({ settings }: SettingSourcesSectionProps) {
	const enabledSources = new Set<SettingSource>(
		settings?.settingSources ?? ['user', 'project', 'local']
	);

	const handleSourceToggle = async (source: SettingSource, checked: boolean) => {
		const currentSources: SettingSource[] = Array.from(enabledSources);
		const newSources: SettingSource[] = checked
			? [...currentSources, source]
			: currentSources.filter((s) => s !== source);

		try {
			await updateGlobalSettings({ settingSources: newSources });
		} catch (error) {
			console.error('Failed to update setting sources:', error);
			toast.error('Failed to update setting sources');
		}
	};

	return (
		<div class="space-y-6">
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<h3 class="mb-4 text-sm font-medium text-gray-200">Settings Sources</h3>
				<p class="mb-4 text-xs text-gray-500">
					Select which sources to load settings from. Settings are merged with later sources taking
					precedence.
				</p>
				<div class="space-y-3">
					{SETTING_SOURCE_OPTIONS.map((option) => (
						<SettingToggle
							key={option.value}
							label={option.label}
							description={option.description}
							checked={enabledSources.has(option.value)}
							onChange={(checked) => handleSourceToggle(option.value, checked)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
