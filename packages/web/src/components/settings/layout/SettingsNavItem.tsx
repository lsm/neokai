/**
 * SettingsNavItem - Individual navigation item in settings sidebar
 *
 * Displays a single settings section with icon and label.
 */

import { SettingsIcon } from './SettingsIcon.tsx';
import type { SettingsSection } from '../../../lib/constants/settings-sections.ts';

export interface SettingsNavItemProps {
	section: SettingsSection;
	isActive: boolean;
	onClick: () => void;
}

export function SettingsNavItem({ section, isActive, onClick }: SettingsNavItemProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			class={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
				isActive
					? 'bg-blue-500/10 text-blue-400'
					: 'text-gray-300 hover:bg-dark-700 hover:text-gray-100'
			}`}
			title={section.description}
		>
			<span class="flex-shrink-0">
				<SettingsIcon name={section.icon} class="h-5 w-5" />
			</span>
			<span class="flex-1">{section.label}</span>
		</button>
	);
}
