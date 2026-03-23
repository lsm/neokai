/**
 * Global Spaces Agent RPC Handlers.
 *
 * RPC handlers for the Global Spaces Agent:
 * - spaces.global.setActiveSpace — Set the active space context
 */

import type { MessageHub } from '@neokai/shared';
import type { GlobalSpacesState } from '../space/tools/global-spaces-tools';

/**
 * Set up RPC handlers for the Global Spaces Agent.
 * Called after provisionGlobalSpacesAgent() with the shared state.
 */
export function setupGlobalSpacesHandlers(messageHub: MessageHub, state: GlobalSpacesState): void {
	messageHub.onRequest('spaces.global.setActiveSpace', async (data) => {
		const params = data as { spaceId: string | null };
		state.activeSpaceId = params.spaceId ?? null;
		return { success: true, activeSpaceId: state.activeSpaceId };
	});
}
