/**
 * PermissionSettingsSection - Permission mode settings
 *
 * Configure default permission behavior for operations.
 */

import type { GlobalSettings, PermissionMode } from '@neokai/shared';
import { SettingSelect } from '../../shared/SettingSelect.tsx';
import { updateGlobalSettings } from '../../../../lib/api-helpers.ts';
import { toast } from '../../../../lib/toast.ts';

const PERMISSION_MODE_OPTIONS: Array<{
	value: PermissionMode;
	label: string;
	description: string;
}> = [
	{
		value: 'default',
		label: 'Default',
		description: 'Ask for permission on potentially dangerous actions',
	},
	{
		value: 'acceptEdits',
		label: 'Accept Edits',
		description: 'Auto-accept file edits, ask for other actions',
	},
	{
		value: 'bypassPermissions',
		label: 'Bypass All',
		description: 'Skip all permission prompts (use with caution)',
	},
	{
		value: 'plan',
		label: 'Plan Mode',
		description: 'Plan changes without executing them',
	},
	{
		value: 'dontAsk',
		label: "Don't Ask",
		description: 'Never ask for permission (most permissive)',
	},
];

export interface PermissionSettingsSectionProps {
	settings: GlobalSettings | null;
}

export function PermissionSettingsSection({ settings }: PermissionSettingsSectionProps) {
	const handlePermissionModeChange = async (value: string) => {
		try {
			await updateGlobalSettings({ permissionMode: value as PermissionMode });
		} catch (error) {
			console.error('Failed to update permission mode:', error);
			toast.error('Failed to update permission mode');
		}
	};

	return (
		<div class="space-y-6">
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<h3 class="mb-4 text-sm font-medium text-gray-200">Permission Mode</h3>
				<div class="space-y-4">
					<SettingSelect
						label="Default Permission Mode"
						description="How Claude should handle permissions for operations"
						value={settings?.permissionMode ?? 'default'}
						options={PERMISSION_MODE_OPTIONS}
						onChange={handlePermissionModeChange}
					/>
					<p class="text-xs text-gray-500">
						This setting applies to new sessions. Existing sessions keep their current mode.
					</p>
				</div>
			</div>
		</div>
	);
}
