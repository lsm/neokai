/**
 * GeneralSettingsSection - General application settings
 *
 * Basic application-wide settings.
 */

import type { GlobalSettings } from '@neokai/shared';
import { SettingToggle } from '../../shared/SettingToggle.tsx';
import { updateGlobalSettings } from '../../../../lib/api-helpers.ts';
import { toast } from '../../../../lib/toast.ts';

export interface GeneralSettingsSectionProps {
	settings: GlobalSettings | null;
}

export function GeneralSettingsSection({ settings }: GeneralSettingsSectionProps) {
	const handleShowArchivedChange = async (checked: boolean) => {
		try {
			await updateGlobalSettings({ showArchived: checked });
		} catch (error) {
			console.error('Failed to update showArchived:', error);
			toast.error('Failed to update setting');
		}
	};

	return (
		<div class="space-y-6">
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<h3 class="mb-4 text-sm font-medium text-gray-200">Display Options</h3>
				<div class="space-y-3">
					<SettingToggle
						label="Show Archived Sessions"
						description="Include archived sessions in the session list"
						checked={settings?.showArchived ?? false}
						onChange={handleShowArchivedChange}
					/>
				</div>
			</div>
		</div>
	);
}
