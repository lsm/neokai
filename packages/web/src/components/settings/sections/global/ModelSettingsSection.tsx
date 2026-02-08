/**
 * ModelSettingsSection - Model selection settings
 *
 * Configure the default Claude model for new sessions.
 */

import type { GlobalSettings } from '@neokai/shared';
import { SettingSelect } from '../../shared/SettingSelect.tsx';
import { updateGlobalSettings } from '../../../../lib/api-helpers.ts';
import { toast } from '../../../../lib/toast.ts';

const MODEL_OPTIONS = [
	{ value: '', label: 'Default (Sonnet)' },
	{ value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
	{ value: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
	{ value: 'claude-haiku-3-5-20241022', label: 'Haiku 3.5' },
] as const;

export interface ModelSettingsSectionProps {
	settings: GlobalSettings | null;
}

export function ModelSettingsSection({ settings }: ModelSettingsSectionProps) {
	const handleModelChange = async (value: string) => {
		try {
			await updateGlobalSettings({ model: value || undefined });
		} catch (error) {
			console.error('Failed to update model:', error);
			toast.error('Failed to update model');
		}
	};

	return (
		<div class="space-y-6">
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<h3 class="mb-4 text-sm font-medium text-gray-200">Default Model</h3>
				<div class="space-y-4">
					<SettingSelect
						label="Model"
						description="The default Claude model to use for new sessions"
						value={settings?.model ?? ''}
						options={MODEL_OPTIONS}
						onChange={handleModelChange}
					/>
					<p class="text-xs text-gray-500">Individual sessions can override this setting</p>
				</div>
			</div>
		</div>
	);
}
