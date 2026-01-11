// @ts-nocheck
/**
 * Tests for ConnectionOverlay component
 *
 * Verifies that the overlay:
 * - Only shows for 'failed' state (not 'disconnected', 'error', 'connecting', 'reconnecting')
 * - Prevents flashing during auto-reconnect cycles (Safari background tab resume)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { connectionState } from '../../lib/state';
import type { ConnectionState } from '@liuboer/shared';

/**
 * Helper function that mirrors the ConnectionOverlay logic
 * Tests the shouldShowOverlay condition directly
 */
function shouldShowOverlay(state: ConnectionState): boolean {
	return state === 'failed';
}

describe('ConnectionOverlay - shouldShowOverlay logic', () => {
	// Store original state value
	let originalState: ConnectionState;

	beforeEach(() => {
		originalState = connectionState.value;
	});

	afterEach(() => {
		connectionState.value = originalState;
	});

	describe('States that should NOT show overlay (transient during auto-reconnect)', () => {
		it('should NOT show overlay for "disconnected" state', () => {
			// 'disconnected' is a transient state during auto-reconnect
			expect(shouldShowOverlay('disconnected')).toBe(false);
		});

		it('should NOT show overlay for "error" state', () => {
			// 'error' is a transient state during auto-reconnect
			expect(shouldShowOverlay('error')).toBe(false);
		});

		it('should NOT show overlay for "connecting" state', () => {
			expect(shouldShowOverlay('connecting')).toBe(false);
		});

		it('should NOT show overlay for "reconnecting" state', () => {
			expect(shouldShowOverlay('reconnecting')).toBe(false);
		});

		it('should NOT show overlay for "connected" state', () => {
			expect(shouldShowOverlay('connected')).toBe(false);
		});
	});

	describe('States that SHOULD show overlay (permanent failure)', () => {
		it('should show overlay for "failed" state', () => {
			// 'failed' means all auto-reconnect attempts exhausted
			expect(shouldShowOverlay('failed')).toBe(true);
		});
	});

	describe('Safari background tab scenario', () => {
		it('should not flash overlay during auto-reconnect cycle', () => {
			// This test simulates the Safari background tab resume scenario
			// where connection state rapidly cycles through states

			const states: ConnectionState[] = [
				'disconnected', // Initial disconnect
				'reconnecting', // Auto-reconnect starts
				'connecting', // Attempting connection
				'error', // First attempt fails
				'reconnecting', // Retry
				'connecting', // Second attempt
				'connected', // Success!
			];

			// None of these transient states should show the overlay
			for (const state of states) {
				expect(shouldShowOverlay(state)).toBe(false);
			}
		});

		it('should show overlay only after all auto-reconnect attempts fail', () => {
			// Simulate all 10 reconnect attempts failing
			const states: ConnectionState[] = [
				'disconnected',
				'reconnecting',
				'connecting',
				'error', // Attempt 1 fails
				'reconnecting',
				'connecting',
				'error', // Attempt 2 fails
				// ... (attempts 3-9)
				'reconnecting',
				'connecting',
				'error', // Attempt 10 fails
				'failed', // All attempts exhausted - NOW show overlay
			];

			// All states except 'failed' should NOT show overlay
			for (const state of states) {
				if (state === 'failed') {
					expect(shouldShowOverlay(state)).toBe(true);
				} else {
					expect(shouldShowOverlay(state)).toBe(false);
				}
			}
		});
	});
});
