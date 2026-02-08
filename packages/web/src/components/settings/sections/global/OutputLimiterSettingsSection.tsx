/**
 * OutputLimiterSettingsSection - Output limiter configuration
 *
 * Configure tool output limits for performance.
 *
 * TODO: Extract output limiter logic from GlobalSettingsEditor
 */

import type { GlobalSettings } from '@neokai/shared';

export interface OutputLimiterSettingsSectionProps {
	settings: GlobalSettings | null;
}

export function OutputLimiterSettingsSection({ settings }: OutputLimiterSettingsSectionProps) {
	const outputLimiter = settings?.outputLimiter;

	return (
		<div class="space-y-6">
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<h3 class="mb-4 text-sm font-medium text-gray-200">Output Limiter</h3>
				<p class="text-sm text-gray-400">
					Output limiter configuration will be migrated from the existing settings modal.
				</p>
				{outputLimiter && (
					<p class="mt-2 text-xs text-gray-500">
						Current status: {outputLimiter.enabled ? 'Enabled' : 'Disabled'}
					</p>
				)}
			</div>
		</div>
	);
}
