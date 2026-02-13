import { currentSessionIdSignal, currentRoomIdSignal } from '../lib/signals.ts';
import { sessions } from '../lib/state.ts';
import ChatContainer from './ChatContainer.tsx';
import Room from './Room.tsx';
import Lobby from './Lobby.tsx';

export default function MainContent() {
	// IMPORTANT: Access .value directly in component body to enable Preact Signals auto-tracking
	// The @preact/preset-vite plugin will transform this to create proper subscriptions
	const sessionId = currentSessionIdSignal.value;
	const roomId = currentRoomIdSignal.value;
	const sessionsList = sessions.value;

	// Room route takes priority
	if (roomId) {
		return <Room key={roomId} roomId={roomId} />;
	}

	// Validate that the current session actually exists in the sessions list
	// (handles case where session is deleted in another tab)
	const sessionExists = sessionId && sessionsList.some((s) => s.id === sessionId);

	// If there's a valid session, show the chat
	if (sessionId && sessionExists) {
		return <ChatContainer key={sessionId} sessionId={sessionId} />;
	}

	// Default: Show Lobby (home page)
	return <Lobby />;
}
