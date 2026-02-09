/**
 * SettingsLayout - Main layout wrapper for settings pages
 *
 * Provides a consistent layout with sidebar navigation and content area
 * for both global and session settings pages.
 */

import { type ComponentChildren } from 'preact';
import { SettingsSidebar } from './SettingsSidebar.tsx';
import { SettingsContentArea } from './SettingsContentArea.tsx';
import type { SettingsSection } from '../../../lib/constants/settings-sections.ts';

export interface SettingsLayoutProps {
	type: 'global' | 'session';
	sessionId?: string;
	sections: readonly SettingsSection[];
	activeSection: string;
	onSectionChange: (sectionId: string) => void;
	children: ComponentChildren;
}

export function SettingsLayout({
	type,
	sessionId,
	sections,
	activeSection,
	onSectionChange,
	children,
}: SettingsLayoutProps) {
	return (
		<div class="flex h-screen bg-dark-900">
			<SettingsSidebar
				sections={sections}
				activeSection={activeSection}
				onSectionChange={onSectionChange}
				type={type}
				sessionId={sessionId}
			/>
			<SettingsContentArea>{children}</SettingsContentArea>
		</div>
	);
}
