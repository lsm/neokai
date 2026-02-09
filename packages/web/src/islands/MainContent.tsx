import { lazy } from 'preact/compat';
import { currentSessionIdSignal } from '../lib/signals.ts';
import { sessions } from '../lib/state.ts';
import {
	getSettingsSectionFromPath,
	getSessionSettingsFromPath,
	isSettingsPath,
} from '../lib/router.ts';
import ChatContainer from './ChatContainer.tsx';
import RecentSessions from '../components/RecentSessions.tsx';
import { Suspense } from 'preact/compat';

// Lazy load settings pages to avoid loading them when not needed
const GlobalSettingsPage = lazy(() =>
	import('./settings/GlobalSettingsPage.tsx').then((m) => ({ default: m.GlobalSettingsPage }))
);
const SessionSettingsPage = lazy(() =>
	import('./settings/SessionSettingsPage.tsx').then((m) => ({ default: m.SessionSettingsPage }))
);

export default function MainContent() {
	// IMPORTANT: Access .value directly in component body to enable Preact Signals auto-tracking
	// The @preact/preset-vite plugin will transform this to create proper subscriptions
	const sessionId = currentSessionIdSignal.value;
	const sessionsList = sessions.value;
	const currentPath = window.location.pathname;

	// Check if we're on a settings route
	if (isSettingsPath(currentPath)) {
		// Global settings route: /settings or /settings/:section
		const settingsSection = getSettingsSectionFromPath(currentPath);
		if (settingsSection) {
			return (
				<Suspense fallback={<SettingsLoadingFallback />}>
					<GlobalSettingsPage />
				</Suspense>
			);
		}

		// Session settings route: /session/:sessionId/settings or /session/:sessionId/settings/:section
		const sessionSettingsMatch = getSessionSettingsFromPath(currentPath);
		if (sessionSettingsMatch) {
			return (
				<Suspense fallback={<SettingsLoadingFallback />}>
					<SessionSettingsPage sessionId={sessionSettingsMatch.sessionId} />
				</Suspense>
			);
		}
	}

	// Validate that the current session actually exists in the sessions list
	// (handles case where session is deleted in another tab)
	const sessionExists = sessionId && sessionsList.some((s) => s.id === sessionId);

	if (!sessionId || !sessionExists) {
		return <RecentSessions sessions={sessionsList} />;
	}

	return <ChatContainer key={sessionId} sessionId={sessionId} />;
}

function SettingsLoadingFallback() {
	return (
		<div class="flex h-screen items-center justify-center bg-dark-900">
			<div class="text-gray-400">Loading settings...</div>
		</div>
	);
}
