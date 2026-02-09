/**
 * UiSettingsSection - UI preference settings
 *
 * Configure user interface preferences.
 */

import type { GlobalSettings } from '@neokai/shared';
import { SettingToggle } from '../../shared/SettingToggle.tsx';
import { updateGlobalSettings } from '../../../../lib/api-helpers.ts';
import { toast } from '../../../../lib/toast.ts';

export interface UiSettingsSectionProps {
	settings: GlobalSettings | null;
}

export function UiSettingsSection({ settings }: UiSettingsSectionProps) {
	const handleAutoScrollChange = async (checked: boolean) => {
		try {
			await updateGlobalSettings({ autoScroll: checked });
		} catch (error) {
			console.error('Failed to update auto-scroll:', error);
			toast.error('Failed to update auto-scroll');
		}
	};

	const handleCoordinatorModeChange = async (checked: boolean) => {
		try {
			await updateGlobalSettings({ coordinatorMode: checked });
		} catch (error) {
			console.error('Failed to update coordinator mode:', error);
			toast.error('Failed to update coordinator mode');
		}
	};

	return (
		<div class="space-y-6">
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<h3 class="mb-4 text-sm font-medium text-gray-200">Chat Behavior</h3>
				<div class="space-y-3">
					<SettingToggle
						label="Auto-scroll"
						description="Automatically scroll to the bottom when new messages arrive"
						checked={settings?.autoScroll ?? true}
						onChange={handleAutoScrollChange}
					/>
				</div>
			</div>

			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<h3 class="mb-4 text-sm font-medium text-gray-200">Agent Coordination</h3>
				<div class="space-y-3">
					<SettingToggle
						label="Coordinator Mode"
						description="When enabled, the main agent delegates tasks to specialized subagents"
						checked={settings?.coordinatorMode ?? false}
						onChange={handleCoordinatorModeChange}
					/>
				</div>
			</div>
		</div>
	);
}
