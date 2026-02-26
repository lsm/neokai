/**
 * TurnTracker - Tracks active turns for agent sessions
 *
 * Maintains an in-memory map of sessionId → current turnId.
 * Used by the mirroring system to tag messages with the correct turn.
 *
 * Turn IDs are deterministic: `turn_{groupId}_{iteration}_{role}`
 * This allows dedup checks and recovery without persistent state.
 */

export class TurnTracker {
	/** Map: sessionId → current turnId */
	private activeTurns = new Map<string, string>();

	/**
	 * Start a new turn for a session.
	 * Returns the generated turnId.
	 */
	startTurn(sessionId: string, groupId: string, iteration: number, role: 'craft' | 'lead'): string {
		const turnId = `turn_${groupId}_${iteration}_${role}`;
		this.activeTurns.set(sessionId, turnId);
		return turnId;
	}

	/**
	 * Get the current turnId for a session, or null if no active turn.
	 */
	getCurrentTurnId(sessionId: string): string | null {
		return this.activeTurns.get(sessionId) ?? null;
	}

	/**
	 * End the current turn for a session.
	 */
	endTurn(sessionId: string): void {
		this.activeTurns.delete(sessionId);
	}

	/**
	 * Clear all tracked turns (used on shutdown).
	 */
	clear(): void {
		this.activeTurns.clear();
	}
}
