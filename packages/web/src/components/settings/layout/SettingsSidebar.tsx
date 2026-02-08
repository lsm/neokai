/**
 * SettingsSidebar - Navigation sidebar for settings pages
 *
 * Provides a list of navigation items for settings sections.
 */

import { navigateToHome, navigateToSession } from '../../../lib/router.ts';
import { SettingsNavItem } from './SettingsNavItem.tsx';
import type { SettingsSection } from '../../../lib/constants/settings-sections.ts';

export interface SettingsSidebarProps {
	sections: readonly SettingsSection[];
	activeSection: string;
	onSectionChange: (sectionId: string) => void;
	type: 'global' | 'session';
	sessionId?: string;
}

export function SettingsSidebar({
	sections,
	activeSection,
	onSectionChange,
	type,
	sessionId,
}: SettingsSidebarProps) {
	const handleBackClick = () => {
		if (type === 'global') {
			navigateToHome();
		} else if (sessionId) {
			navigateToSession(sessionId);
		}
	};

	return (
		<aside class="flex w-64 flex-col border-r border-dark-700 bg-dark-850">
			{/* Header */}
			<div class="border-b border-dark-700 p-4">
				<h2 class="text-lg font-semibold text-gray-100">
					{type === 'global' ? 'Global Settings' : 'Session Settings'}
				</h2>
				{type === 'session' && <p class="mt-1 text-xs text-gray-400">Overrides global settings</p>}
			</div>

			{/* Navigation Items */}
			<nav class="flex-1 space-y-1 overflow-y-auto p-2">
				{sections.map((section) => (
					<SettingsNavItem
						key={section.id}
						section={section}
						isActive={activeSection === section.id}
						onClick={() => onSectionChange(section.id)}
					/>
				))}
			</nav>

			{/* Footer Actions */}
			<div class="border-t border-dark-700 p-4">
				<button
					type="button"
					onClick={handleBackClick}
					class="w-full rounded-lg bg-dark-700 px-4 py-2 text-sm font-medium text-gray-200 transition-colors hover:bg-dark-600"
				>
					{type === 'global' ? 'Back to Home' : 'Back to Session'}
				</button>
			</div>
		</aside>
	);
}
