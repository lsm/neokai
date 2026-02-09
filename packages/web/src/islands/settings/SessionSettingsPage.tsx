/**
 * SessionSettingsPage - Session-specific settings page
 *
 * Provides a dedicated page for session settings with sidebar navigation.
 * Route: /session/:sessionId/settings or /session/:sessionId/settings/:section
 */

import { useEffect, useState } from 'preact/hooks';
import { SettingsLayout } from '../../components/settings/layout/SettingsLayout.tsx';
import { SESSION_SETTINGS_SECTIONS } from '../../lib/constants/settings-sections.ts';
import { navigateToSessionSettings, navigateToSession } from '../../lib/router.ts';
import { sessions } from '../../lib/state.ts';
import { SettingsHeader } from '../../components/settings/shared/SettingsHeader.tsx';
import { SessionGeneralSettingsSection } from '../../components/settings/sections/session/SessionGeneralSettingsSection.tsx';

export interface SessionSettingsPageProps {
	sessionId: string;
}

export function SessionSettingsPage({ sessionId }: SessionSettingsPageProps) {
	const [activeSection, setActiveSection] = useState('general');
	const sessionsList = sessions.value;
	const session = sessionsList.find((s) => s.id === sessionId);

	// Read section from URL on mount
	useEffect(() => {
		const path = window.location.pathname;
		const match = path.match(/^\/session\/[a-f0-9-]+\/settings(?:\/([^/]+))?$/);
		if (match?.[1]) {
			setActiveSection(match[1]);
		}
	}, []);

	const handleSectionChange = (sectionId: string) => {
		setActiveSection(sectionId);
		navigateToSessionSettings(sessionId, sectionId);
	};

	// Validate session exists
	if (!session) {
		return (
			<div class="flex h-screen items-center justify-center bg-dark-900">
				<div class="text-gray-400">Session not found</div>
			</div>
		);
	}

	// Render the active section
	const renderSection = () => {
		switch (activeSection) {
			case 'general':
				return <SessionGeneralSettingsSection sessionId={sessionId} />;
			// TODO: Add other session sections
			default:
				return <SessionGeneralSettingsSection sessionId={sessionId} />;
		}
	};

	const currentSection = SESSION_SETTINGS_SECTIONS.find((s) => s.id === activeSection);

	return (
		<SettingsLayout
			type="session"
			sessionId={sessionId}
			sections={SESSION_SETTINGS_SECTIONS}
			activeSection={activeSection}
			onSectionChange={handleSectionChange}
		>
			{currentSection && (
				<SettingsHeader
					title={currentSection.label}
					description={currentSection.description}
					breadcrumbs={[
						{ label: 'Home', onClick: () => navigateToSession(sessionId) },
						{ label: session.title, onClick: () => navigateToSession(sessionId) },
						{ label: 'Settings' },
						{ label: currentSection.label },
					]}
				/>
			)}
			{renderSection()}
		</SettingsLayout>
	);
}
