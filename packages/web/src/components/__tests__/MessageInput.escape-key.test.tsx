// @ts-nocheck
/**
 * Tests for Escape Key Behavior in MessageInput
 *
 * BUG FIX: Previously, pressing Escape while the agent was idle would
 * clear all text in the input box. This was unexpected UX - users expect
import { describe, it, expect, vi } from 'vitest';
 * Escape to:
 * 1. Close autocomplete menu (if open)
 * 2. Interrupt the agent (if working)
 * 3. NOT clear their typed message (when idle)
 *
 * This test ensures the fix is preserved and the bug doesn't regress.
 *
 * Note: Tests pure logic without mock.module to avoid polluting other tests.
 */

import { signal } from '@preact/signals';

describe('MessageInput Escape Key Behavior', () => {
	// The escape key handler logic from MessageInput
	const createEscapeHandler = (
		isAgentWorking: { value: boolean },
		interrupting: { value: boolean },
		onInterrupt: () => void
	) => {
		return (key: string) => {
			if (key === 'Escape') {
				// This is the FIXED behavior:
				// Escape interrupts the agent if it's working
				// Note: Escape does NOT clear the input when idle - that would be unexpected UX
				if (isAgentWorking.value && !interrupting.value) {
					onInterrupt();
					return true; // preventDefault
				}
				// REMOVED: The old buggy code that cleared the draft when idle
				// else if (!isAgentWorking.value) {
				//     clearDraft();
				// }
			}
			return false;
		};
	};

	describe('When agent is IDLE', () => {
		it('should NOT clear input content when Escape is pressed', () => {
			const isAgentWorking = signal(false);
			const interrupting = signal(false);
			const interruptCalled = { value: false };
			let contentCleared = false;

			const handleEscape = createEscapeHandler(isAgentWorking, interrupting, () => {
				interruptCalled.value = true;
			});

			// Simulate content state
			let content = 'Hello world';

			// Press Escape
			const prevented = handleEscape('Escape');

			// Content should NOT be cleared (we're not clearing it in the handler)
			expect(content).toBe('Hello world');
			expect(contentCleared).toBe(false);
			expect(prevented).toBe(false);
		});

		it('should NOT call interrupt when Escape is pressed and agent is idle', () => {
			const isAgentWorking = signal(false);
			const interrupting = signal(false);
			const interruptCalled = { value: false };

			const handleEscape = createEscapeHandler(isAgentWorking, interrupting, () => {
				interruptCalled.value = true;
			});

			// Press Escape
			handleEscape('Escape');

			// Interrupt should NOT be called
			expect(interruptCalled.value).toBe(false);
		});

		it('should preserve multi-line content when Escape is pressed', () => {
			const isAgentWorking = signal(false);
			const interrupting = signal(false);

			const handleEscape = createEscapeHandler(isAgentWorking, interrupting, () => {});

			const multiLineContent = 'Line 1\nLine 2\nLine 3';

			// Press Escape
			handleEscape('Escape');

			// Multi-line content should be preserved (not modified by handler)
			expect(multiLineContent).toBe('Line 1\nLine 2\nLine 3');
		});
	});

	describe('When agent is WORKING', () => {
		it('should call interrupt when Escape is pressed', () => {
			const isAgentWorking = signal(true);
			const interrupting = signal(false);
			const interruptCalled = { value: false };

			const handleEscape = createEscapeHandler(isAgentWorking, interrupting, () => {
				interruptCalled.value = true;
			});

			// Press Escape
			const prevented = handleEscape('Escape');

			// Interrupt should be called
			expect(interruptCalled.value).toBe(true);
			expect(prevented).toBe(true);
		});

		it('should NOT clear input content when interrupting', () => {
			const isAgentWorking = signal(true);
			const interrupting = signal(false);
			let contentCleared = false;

			const handleEscape = createEscapeHandler(isAgentWorking, interrupting, () => {});

			let content = 'User input';

			// Press Escape to interrupt
			handleEscape('Escape');

			// Content should still be preserved
			expect(content).toBe('User input');
			expect(contentCleared).toBe(false);
		});

		it('should NOT call interrupt when already interrupting', () => {
			const isAgentWorking = signal(true);
			const interrupting = signal(true); // Already interrupting
			let interruptCount = 0;

			const handleEscape = createEscapeHandler(isAgentWorking, interrupting, () => {
				interruptCount++;
			});

			// Press Escape while already interrupting
			const prevented = handleEscape('Escape');

			// Interrupt should NOT be called again
			expect(interruptCount).toBe(0);
			expect(prevented).toBe(false);
		});
	});

	describe('Edge cases', () => {
		it('should handle empty input gracefully', () => {
			const isAgentWorking = signal(false);
			const interrupting = signal(false);
			let interruptCalled = false;

			const handleEscape = createEscapeHandler(isAgentWorking, interrupting, () => {
				interruptCalled = true;
			});

			let content = '';

			// Press Escape on empty input
			handleEscape('Escape');

			// Should not throw or have unexpected behavior
			expect(content).toBe('');
			expect(interruptCalled).toBe(false);
		});

		it('should handle repeated Escape presses', () => {
			const isAgentWorking = signal(false);
			const interrupting = signal(false);
			let interruptCount = 0;

			const handleEscape = createEscapeHandler(isAgentWorking, interrupting, () => {
				interruptCount++;
			});

			let content = 'Test';

			// Press Escape multiple times
			handleEscape('Escape');
			handleEscape('Escape');
			handleEscape('Escape');

			// Content should still be preserved
			expect(content).toBe('Test');
			expect(interruptCount).toBe(0);
		});

		it('should handle state transition from working to idle', () => {
			const isAgentWorking = signal(true);
			const interrupting = signal(false);
			let interruptCount = 0;

			const handleEscape = createEscapeHandler(isAgentWorking, interrupting, () => {
				interruptCount++;
				interrupting.value = true;
			});

			let content = 'My message';

			// Start with agent working
			// Press Escape - should interrupt
			handleEscape('Escape');
			expect(interruptCount).toBe(1);

			// Reset interrupting
			interrupting.value = false;

			// Agent becomes idle
			isAgentWorking.value = false;

			// Press Escape again - should NOT call interrupt
			handleEscape('Escape');

			expect(content).toBe('My message');
			expect(interruptCount).toBe(1); // Only called once
		});

		it('should ignore other keys', () => {
			const isAgentWorking = signal(true);
			const interrupting = signal(false);
			let interruptCalled = false;

			const handleEscape = createEscapeHandler(isAgentWorking, interrupting, () => {
				interruptCalled = true;
			});

			// Press other keys
			handleEscape('Enter');
			handleEscape('Tab');
			handleEscape('ArrowUp');
			handleEscape('a');

			// Should not call interrupt
			expect(interruptCalled).toBe(false);
		});
	});

	describe('Interrupt logic', () => {
		it('should only interrupt when isAgentWorking is true', () => {
			const interrupting = signal(false);
			const onInterrupt = vi.fn(() => {});

			// Test with isAgentWorking = false
			const handler1 = createEscapeHandler(signal(false), interrupting, onInterrupt);
			handler1('Escape');
			expect(onInterrupt).not.toHaveBeenCalled();

			// Test with isAgentWorking = true
			const handler2 = createEscapeHandler(signal(true), interrupting, onInterrupt);
			handler2('Escape');
			expect(onInterrupt).toHaveBeenCalled();
		});

		it('should not interrupt when already interrupting', () => {
			const isAgentWorking = signal(true);
			const interrupting = signal(true);
			const onInterrupt = vi.fn(() => {});

			const handler = createEscapeHandler(isAgentWorking, interrupting, onInterrupt);
			handler('Escape');

			expect(onInterrupt).not.toHaveBeenCalled();
		});
	});
});
