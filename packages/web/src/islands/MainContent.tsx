import { currentSessionIdSignal } from '../lib/signals.ts';
import { sessions } from '../lib/state.ts';
import ChatContainer from './ChatContainer.tsx';
import RecentSessions from '../components/RecentSessions.tsx';

export default function MainContent() {
	// IMPORTANT: Access .value directly in component body to enable Preact Signals auto-tracking
	// The @preact/preset-vite plugin will transform this to create proper subscriptions
	const sessionId = currentSessionIdSignal.value;
	const sessionsList = sessions.value;

	// Validate that the current session actually exists in the sessions list
	// (handles case where session is deleted in another tab)
	const sessionExists = sessionId && sessionsList.some((s) => s.id === sessionId);

	if (!sessionId || !sessionExists) {
		return <RecentSessions sessions={sessionsList} />;
	}

	return <ChatContainer key={sessionId} sessionId={sessionId} />;
}
