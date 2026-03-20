/**
 * SpacesPage - Chat interface for the Global Spaces Agent
 *
 * Uses the pre-provisioned `spaces:global` session (Global Spaces Agent)
 * which is auto-created on daemon startup with space management MCP tools.
 * Renders a full ChatContainer for the agent session.
 */

import { useEffect } from 'preact/hooks';
import { spaceStore } from '../lib/space-store.ts';
import ChatContainer from './ChatContainer.tsx';

const GLOBAL_SESSION_ID = 'spaces:global';

export function SpacesPage() {
	// Initialize global space list on mount (for Context Panel sidebar)
	useEffect(() => {
		spaceStore.initGlobalList().catch(() => {
			// Error tracked inside initGlobalList
		});
	}, []);

	return <ChatContainer sessionId={GLOBAL_SESSION_ID} />;
}
