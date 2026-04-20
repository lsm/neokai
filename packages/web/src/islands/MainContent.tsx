import { lazy, Suspense } from 'preact/compat';
import {
	currentSessionIdSignal,
	currentRoomIdSignal,
	currentRoomSessionIdSignal,
	currentRoomTaskIdSignal,
	currentRoomGoalIdSignal,
	currentSpaceIdSignal,
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	currentSpaceViewModeSignal,
	navSectionSignal,
	settingsSectionSignal,
} from '../lib/signals.ts';
import { sessions } from '../lib/state.ts';
import Lobby from './Lobby.tsx';
import { BottomTabBar } from './BottomTabBar.tsx';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';

// Lazy-loaded route components — reduces initial module count in dev mode
const ChatContainer = lazy(() => import('./ChatContainer.tsx'));
const Room = lazy(() => import('./Room.tsx'));
const SpaceIsland = lazy(() => import('./SpaceIsland.tsx'));
const SessionsPage = lazy(() =>
	import('./SessionsPage.tsx').then((m) => ({ default: m.SessionsPage }))
);
const SpacesPage = lazy(() => import('./SpacesPage.tsx').then((m) => ({ default: m.SpacesPage })));
const Inbox = lazy(() =>
	import('../components/inbox/Inbox.tsx').then((m) => ({ default: m.Inbox }))
);

// Lazy-loaded settings panels
const GeneralSettings = lazy(() =>
	import('../components/settings/GeneralSettings.tsx').then((m) => ({ default: m.GeneralSettings }))
);
const ProvidersSettings = lazy(() =>
	import('../components/settings/ProvidersSettings.tsx').then((m) => ({
		default: m.ProvidersSettings,
	}))
);
const McpServersSettings = lazy(() =>
	import('../components/settings/McpServersSettings.tsx').then((m) => ({
		default: m.McpServersSettings,
	}))
);
const AppMcpServersSettings = lazy(() =>
	import('../components/settings/AppMcpServersSettings.tsx').then((m) => ({
		default: m.AppMcpServersSettings,
	}))
);
const SkillsRegistry = lazy(() =>
	import('../components/settings/SkillsRegistry.tsx').then((m) => ({ default: m.SkillsRegistry }))
);
const FallbackModelsSettings = lazy(() =>
	import('../components/settings/FallbackModelsSettings.tsx').then((m) => ({
		default: m.FallbackModelsSettings,
	}))
);
const UsageAnalytics = lazy(() =>
	import('../components/settings/UsageAnalytics.tsx').then((m) => ({ default: m.UsageAnalytics }))
);
const AboutSection = lazy(() =>
	import('../components/settings/AboutSection.tsx').then((m) => ({ default: m.AboutSection }))
);
const NeoSettings = lazy(() =>
	import('../components/settings/NeoSettings.tsx').then((m) => ({ default: m.NeoSettings }))
);

/** Shared Suspense fallback for lazy-loaded route components. */
const lazyFallback = (
	<div class="flex-1 flex items-center justify-center bg-dark-900">
		<div class="text-xs text-gray-600">Loading...</div>
	</div>
);

export default function MainContent() {
	// IMPORTANT: Access .value directly in component body to enable Preact Signals auto-tracking
	// The @preact/preset-vite plugin will transform this to create proper subscriptions
	const sessionId = currentSessionIdSignal.value;
	const roomId = currentRoomIdSignal.value;
	const roomSessionId = currentRoomSessionIdSignal.value;
	const roomTaskId = currentRoomTaskIdSignal.value;
	const roomGoalId = currentRoomGoalIdSignal.value;
	const spaceId = currentSpaceIdSignal.value;
	const spaceSessionViewId = currentSpaceSessionIdSignal.value;
	const spaceTaskViewId = currentSpaceTaskIdSignal.value;
	const spaceViewMode = currentSpaceViewModeSignal.value;
	const sessionsList = sessions.value;
	const navSection = navSectionSignal.value;
	const settingsSection = settingsSectionSignal.value;

	// Validate that the current session actually exists in the sessions list
	// (handles case where session is deleted in another tab)
	const sessionExists = !!(sessionId && sessionsList.some((s) => s.id === sessionId));

	// Compute a stable key that changes when the major content view changes.
	// This drives the animate-fadeIn-200 transition wrapper below.
	let contentKey: string;
	if (spaceId) {
		contentKey = `space-${spaceId}-${spaceViewMode}`;
	} else if (navSection === 'spaces') {
		contentKey = 'spaces';
	} else if (roomId) {
		contentKey = `room-${roomId}`;
	} else if (sessionExists) {
		contentKey = `chat-${sessionId}`;
	} else if (navSection === 'chats') {
		contentKey = 'chats';
	} else if (navSection === 'settings') {
		// Settings sub-section changes don't re-animate — only the major section switch does
		contentKey = 'settings';
	} else if (navSection === 'inbox') {
		contentKey = 'inbox';
	} else {
		contentKey = 'home';
	}

	function renderContent() {
		// Space route takes priority
		if (spaceId) {
			return (
				<Suspense fallback={lazyFallback}>
					<SpaceIsland
						spaceId={spaceId}
						viewMode={spaceViewMode}
						sessionViewId={spaceSessionViewId}
						taskViewId={spaceTaskViewId}
					/>
				</Suspense>
			);
		}

		// /spaces route: show standalone spaces page (no sidebar)
		if (navSection === 'spaces') {
			return (
				<Suspense fallback={lazyFallback}>
					<SpacesPage />
				</Suspense>
			);
		}

		// Room route
		if (roomId) {
			return (
				<Suspense fallback={lazyFallback}>
					<Room
						key={roomId}
						roomId={roomId}
						sessionViewId={roomSessionId}
						taskViewId={roomTaskId}
						missionViewId={roomGoalId}
					/>
				</Suspense>
			);
		}

		// If there's a valid session, show the chat
		if (sessionExists && sessionId) {
			return (
				<Suspense fallback={lazyFallback}>
					<ChatContainer key={sessionId} sessionId={sessionId} />
				</Suspense>
			);
		}

		// /sessions route: show sessions grid
		if (navSection === 'chats') {
			return (
				<Suspense fallback={lazyFallback}>
					<SessionsPage />
				</Suspense>
			);
		}

		// If Settings is selected in NavRail, show the selected settings section content
		if (navSection === 'settings') {
			return (
				<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
					{/* Settings Header */}
					<div class="px-6 py-4 border-b border-dark-700 flex items-center gap-3">
						<MobileMenuButton />
						<div>
							<h2 class="text-lg font-semibold text-gray-100">Global Settings</h2>
							<p class="text-sm text-gray-400">Default configurations for new sessions</p>
						</div>
					</div>
					{/* Settings Content */}
					<div class="flex-1 overflow-y-auto p-6">
						<Suspense fallback={lazyFallback}>
							{settingsSection === 'general' && <GeneralSettings />}
							{settingsSection === 'providers' && <ProvidersSettings />}
							{settingsSection === 'mcp-servers' && <McpServersSettings />}
							{settingsSection === 'app-mcp-servers' && <AppMcpServersSettings />}
							{settingsSection === 'skills' && <SkillsRegistry />}
							{settingsSection === 'fallback-models' && <FallbackModelsSettings />}
							{settingsSection === 'neo' && <NeoSettings />}
							{settingsSection === 'usage' && <UsageAnalytics />}
							{settingsSection === 'about' && <AboutSection />}
						</Suspense>
					</div>
				</div>
			);
		}

		// Inbox route
		if (navSection === 'inbox') {
			return (
				<Suspense fallback={lazyFallback}>
					<Inbox />
				</Suspense>
			);
		}

		// Default: Show Lobby (home page)
		return <Lobby />;
	}

	// Wrap content in a keyed div so Preact remounts it (and replays animate-fadeIn-200)
	// whenever the major content view changes.
	// BottomTabBar sits outside the keyed div so it never remounts on view transitions.
	return (
		<>
			<div key={contentKey} class="flex-1 flex flex-col overflow-hidden animate-fadeIn-200">
				{renderContent()}
			</div>
			<BottomTabBar inline />
		</>
	);
}
