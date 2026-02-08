/**
 * ThinkingSettingsSection - Extended thinking settings
 *
 * Configure thinking budget for Claude models.
 */

import type { GlobalSettings, ThinkingLevel } from '@neokai/shared';
import { SettingSelect } from '../../shared/SettingSelect.tsx';
import { updateGlobalSettings } from '../../../../lib/api-helpers.ts';
import { toast } from '../../../../lib/toast.ts';

const THINKING_LEVEL_OPTIONS: Array<{
	value: ThinkingLevel;
	label: string;
	description: string;
}> = [
	{
		value: 'auto',
		label: 'Auto',
		description: 'No thinking budget - SDK default behavior',
	},
	{
		value: 'think8k',
		label: 'Think 8k',
		description: '8,000 token thinking budget',
	},
	{
		value: 'think16k',
		label: 'Think 16k',
		description: '16,000 token thinking budget',
	},
	{
		value: 'think32k',
		label: 'Think 32k',
		description: '32,000 token thinking budget',
	},
];

export interface ThinkingSettingsSectionProps {
	settings: GlobalSettings | null;
}

export function ThinkingSettingsSection({ settings }: ThinkingSettingsSectionProps) {
	const handleThinkingLevelChange = async (value: string) => {
		try {
			await updateGlobalSettings({ thinkingLevel: value as ThinkingLevel });
		} catch (error) {
			console.error('Failed to update thinking level:', error);
			toast.error('Failed to update thinking level');
		}
	};

	return (
		<div class="space-y-6">
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<h3 class="mb-4 text-sm font-medium text-gray-200">Extended Thinking</h3>
				<div class="space-y-4">
					<SettingSelect
						label="Thinking Level"
						description="Amount of thinking tokens to allocate for complex reasoning"
						value={settings?.thinkingLevel ?? 'auto'}
						options={THINKING_LEVEL_OPTIONS}
						onChange={handleThinkingLevelChange}
					/>
					<p class="text-xs text-gray-500">
						Higher thinking budgets allow for more complex reasoning but increase cost and latency.
					</p>
				</div>
			</div>
		</div>
	);
}
