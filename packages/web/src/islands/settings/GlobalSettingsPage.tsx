/**
 * GlobalSettingsPage - Main global settings page
 *
 * Provides a dedicated page for global settings with sidebar navigation.
 * Route: /settings or /settings/:section
 */

import { useEffect, useState } from 'preact/hooks';
import { SettingsLayout } from '../../components/settings/layout/SettingsLayout.tsx';
import { GLOBAL_SETTINGS_SECTIONS } from '../../lib/constants/settings-sections.ts';
import { navigateToSettings } from '../../lib/router.ts';
import { globalSettings } from '../../lib/state.ts';
import { SettingsHeader } from '../../components/settings/shared/SettingsHeader.tsx';
import { ModelSettingsSection } from '../../components/settings/sections/global/ModelSettingsSection.tsx';
import { GeneralSettingsSection } from '../../components/settings/sections/global/GeneralSettingsSection.tsx';
import { AuthenticationSettingsSection } from '../../components/settings/sections/global/AuthenticationSettingsSection.tsx';
import { PermissionSettingsSection } from '../../components/settings/sections/global/PermissionSettingsSection.tsx';
import { ThinkingSettingsSection } from '../../components/settings/sections/global/ThinkingSettingsSection.tsx';
import { UiSettingsSection } from '../../components/settings/sections/global/UiSettingsSection.tsx';
import { SettingSourcesSection } from '../../components/settings/sections/global/SettingSourcesSection.tsx';
import { McpSettingsSection } from '../../components/settings/sections/global/McpSettingsSection.tsx';
import { GlobalToolsSettingsSection } from '../../components/settings/sections/global/GlobalToolsSettingsSection.tsx';
import { OutputLimiterSettingsSection } from '../../components/settings/sections/global/OutputLimiterSettingsSection.tsx';

export function GlobalSettingsPage() {
	const [activeSection, setActiveSection] = useState('general');
	const settings = globalSettings.value;

	// Read section from URL on mount
	useEffect(() => {
		const path = window.location.pathname;
		const match = path.match(/^\/settings(?:\/([^/]+))?$/);
		if (match?.[1]) {
			setActiveSection(match[1]);
		}
	}, []);

	const handleSectionChange = (sectionId: string) => {
		setActiveSection(sectionId);
		navigateToSettings(sectionId);
	};

	// Render the active section
	const renderSection = () => {
		switch (activeSection) {
			case 'general':
				return <GeneralSettingsSection settings={settings} />;
			case 'authentication':
				return <AuthenticationSettingsSection />;
			case 'model':
				return <ModelSettingsSection settings={settings} />;
			case 'permissions':
				return <PermissionSettingsSection settings={settings} />;
			case 'thinking':
				return <ThinkingSettingsSection settings={settings} />;
			case 'ui':
				return <UiSettingsSection settings={settings} />;
			case 'sources':
				return <SettingSourcesSection settings={settings} />;
			case 'mcp':
				return <McpSettingsSection settings={settings} />;
			case 'tools':
				return <GlobalToolsSettingsSection />;
			case 'output-limiter':
				return <OutputLimiterSettingsSection settings={settings} />;
			default:
				return <GeneralSettingsSection settings={settings} />;
		}
	};

	const currentSection = GLOBAL_SETTINGS_SECTIONS.find((s) => s.id === activeSection);

	return (
		<SettingsLayout
			type="global"
			sections={GLOBAL_SETTINGS_SECTIONS}
			activeSection={activeSection}
			onSectionChange={handleSectionChange}
		>
			{currentSection && (
				<SettingsHeader
					title={currentSection.label}
					description={currentSection.description}
					breadcrumbs={[
						{ label: 'Home', onClick: () => navigateToSettings() },
						{ label: 'Settings' },
						{ label: currentSection.label },
					]}
				/>
			)}
			{renderSection()}
		</SettingsLayout>
	);
}
