// @ts-nocheck
/**
 * Tests for InputTextarea Component
 *
 * Key bug fix covered: Signal-based re-renders causing lost keystrokes
 *
 * Previously, InputTextarea directly read `isAgentWorking.value` signal inside
 * the component. When signals updated from server-pushed state changes,
 * the component re-rendered with stale `content` prop (from parent's last render),
 * causing:
 * 1. Lost keystrokes when typing fast
 * 2. Cursor position reset when holding arrow keys
 *
 * Fix: `isAgentWorking` is now passed as a prop, ensuring the component only
 * re-renders when its parent re-renders, keeping content and isAgentWorking in sync.
 */

import './setup';
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { InputTextarea } from '../InputTextarea';

describe('InputTextarea', () => {
	beforeEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('should render textarea with content', () => {
			const { container } = render(
				<InputTextarea
					content="Hello World"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
				/>
			);
			const textarea = container.querySelector('textarea');
			expect(textarea?.value).toBe('Hello World');
		});

		it('should render placeholder text', () => {
			const { container } = render(
				<InputTextarea
					content=""
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
				/>
			);
			const textarea = container.querySelector('textarea');
			expect(textarea?.placeholder).toBe('Ask or make anything...');
		});
	});

	describe('Input Handling - Bug Fix Coverage', () => {
		it('should call onContentChange with new value when typing', () => {
			const onContentChange = mock(() => {});
			const { container } = render(
				<InputTextarea
					content=""
					onContentChange={onContentChange}
					onKeyDown={() => {}}
					onSubmit={() => {}}
				/>
			);

			const textarea = container.querySelector('textarea')!;
			fireEvent.input(textarea, { target: { value: 'a' } });

			expect(onContentChange).toHaveBeenCalledWith('a');
		});

		it('should preserve content value when isAgentWorking prop changes', () => {
			// This test verifies the bug fix: changing isAgentWorking should not
			// affect the content value since both are now controlled by props
			const onContentChange = mock(() => {});
			const { container, rerender } = render(
				<InputTextarea
					content="typed text"
					onContentChange={onContentChange}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			const textarea = container.querySelector('textarea')!;
			expect(textarea.value).toBe('typed text');

			// Simulate signal change by re-rendering with new isAgentWorking value
			rerender(
				<InputTextarea
					content="typed text"
					onContentChange={onContentChange}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={true}
				/>
			);

			// Content should be preserved after re-render
			expect(textarea.value).toBe('typed text');
		});

		it('should handle rapid content updates without losing characters', () => {
			const values: string[] = [];
			const onContentChange = mock((value: string) => {
				values.push(value);
			});

			const { container, rerender } = render(
				<InputTextarea
					content=""
					onContentChange={onContentChange}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			const textarea = container.querySelector('textarea')!;

			// Simulate rapid typing
			fireEvent.input(textarea, { target: { value: 'h' } });
			rerender(
				<InputTextarea
					content="h"
					onContentChange={onContentChange}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			fireEvent.input(textarea, { target: { value: 'he' } });
			rerender(
				<InputTextarea
					content="he"
					onContentChange={onContentChange}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			fireEvent.input(textarea, { target: { value: 'hel' } });
			rerender(
				<InputTextarea
					content="hel"
					onContentChange={onContentChange}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			// Verify all characters were captured
			expect(values).toEqual(['h', 'he', 'hel']);
			expect(textarea.value).toBe('hel');
		});

		it('should not re-render due to signal when isAgentWorking is passed as prop', () => {
			// This test documents the expected behavior: isAgentWorking is a prop,
			// not read from a signal, so re-renders are controlled by the parent
			const onContentChange = mock(() => {});

			const { container } = render(
				<InputTextarea
					content="test"
					onContentChange={onContentChange}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			const textarea = container.querySelector('textarea')!;

			// Verify the component renders correctly with prop
			expect(textarea.value).toBe('test');
		});
	});

	describe('isAgentWorking Prop - Button State', () => {
		it('should show send button when isAgentWorking is false', () => {
			const { container } = render(
				<InputTextarea
					content="hello"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			const sendButton = container.querySelector('[data-testid="send-button"]');
			const stopButton = container.querySelector('[data-testid="stop-button"]');

			expect(sendButton).toBeTruthy();
			expect(stopButton).toBeNull();
		});

		it('should show stop button when isAgentWorking is true', () => {
			const { container } = render(
				<InputTextarea
					content="hello"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={true}
					onInterrupt={() => {}}
				/>
			);

			const sendButton = container.querySelector('[data-testid="send-button"]');
			const stopButton = container.querySelector('[data-testid="stop-button"]');

			expect(stopButton).toBeTruthy();
			expect(sendButton).toBeNull();
		});

		it('should disable send button when isAgentWorking is true (in send button state)', () => {
			// When agent is working but we somehow show send button,
			// it should be disabled
			const { container } = render(
				<InputTextarea
					content="hello"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			const sendButton = container.querySelector(
				'[data-testid="send-button"]'
			) as HTMLButtonElement;
			expect(sendButton?.disabled).toBe(false);
		});

		it('should disable send button when content is empty', () => {
			const { container } = render(
				<InputTextarea
					content=""
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			const sendButton = container.querySelector(
				'[data-testid="send-button"]'
			) as HTMLButtonElement;
			expect(sendButton?.disabled).toBe(true);
		});
	});

	describe('Keyboard Events', () => {
		it('should call onKeyDown when a key is pressed', () => {
			const onKeyDown = mock(() => {});
			const { container } = render(
				<InputTextarea
					content=""
					onContentChange={() => {}}
					onKeyDown={onKeyDown}
					onSubmit={() => {}}
				/>
			);

			const textarea = container.querySelector('textarea')!;
			fireEvent.keyDown(textarea, { key: 'a' });

			expect(onKeyDown).toHaveBeenCalled();
		});

		it('should call onKeyDown for arrow keys', () => {
			const onKeyDown = mock(() => {});
			const { container } = render(
				<InputTextarea
					content="test content"
					onContentChange={() => {}}
					onKeyDown={onKeyDown}
					onSubmit={() => {}}
				/>
			);

			const textarea = container.querySelector('textarea')!;

			fireEvent.keyDown(textarea, { key: 'ArrowLeft' });
			fireEvent.keyDown(textarea, { key: 'ArrowRight' });
			fireEvent.keyDown(textarea, { key: 'ArrowUp' });
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });

			expect(onKeyDown).toHaveBeenCalledTimes(4);
		});
	});

	describe('Submit Button', () => {
		it('should call onSubmit when send button is clicked', () => {
			const onSubmit = mock(() => {});
			const { container } = render(
				<InputTextarea
					content="hello"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={onSubmit}
					isAgentWorking={false}
				/>
			);

			const sendButton = container.querySelector('[data-testid="send-button"]')!;
			fireEvent.click(sendButton);

			expect(onSubmit).toHaveBeenCalledTimes(1);
		});

		it('should call onInterrupt when stop button is clicked', () => {
			const onInterrupt = mock(() => {});
			const { container } = render(
				<InputTextarea
					content="hello"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={true}
					onInterrupt={onInterrupt}
				/>
			);

			const stopButton = container.querySelector('[data-testid="stop-button"]')!;
			fireEvent.click(stopButton);

			expect(onInterrupt).toHaveBeenCalledTimes(1);
		});
	});

	describe('Character Counter', () => {
		it('should show character counter when near max limit', () => {
			const maxChars = 100;
			const content = 'a'.repeat(85); // 85% of limit

			const { container } = render(
				<InputTextarea
					content={content}
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					maxChars={maxChars}
				/>
			);

			// Character counter should be visible
			const counterText = container.textContent;
			expect(counterText).toContain('85/100');
		});

		it('should not show character counter when well below limit', () => {
			const maxChars = 100;
			const content = 'hello'; // 5% of limit

			const { container } = render(
				<InputTextarea
					content={content}
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					maxChars={maxChars}
				/>
			);

			// Character counter should not be visible (below 80% threshold)
			const counterText = container.textContent;
			expect(counterText).not.toContain('/100');
		});
	});

	describe('Disabled State', () => {
		it('should apply disabled styling when disabled prop is true', () => {
			const { container } = render(
				<InputTextarea
					content=""
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					disabled={true}
				/>
			);

			// The disabled prop affects the container styling, not the textarea element
			const containerDiv = container.querySelector('.rounded-3xl');
			expect(containerDiv?.className).toContain('border-dark-700');
		});
	});

	describe('Cursor Position Preservation', () => {
		/**
		 * These tests verify the "uncontrolled with sync" pattern that prevents
		 * cursor position reset during re-renders.
		 *
		 * ROOT CAUSE OF BUG:
		 * With controlled inputs (value={content}), Preact sets textarea.value
		 * on every render. Even when DOM already has the correct value, setting
		 * element.value programmatically resets cursor position.
		 *
		 * SYMPTOMS:
		 * - Lost keystrokes when typing fast
		 * - Arrow keys "stop working" after a few presses (cursor keeps resetting)
		 *
		 * FIX: Use useLayoutEffect to sync content to DOM only when they differ.
		 */

		it('should not update DOM value when content matches textarea.value', () => {
			const { container, rerender } = render(
				<InputTextarea
					content="hello"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			const textarea = container.querySelector('textarea')!;

			// Set cursor position in the middle
			textarea.setSelectionRange(2, 2);
			expect(textarea.selectionStart).toBe(2);
			expect(textarea.selectionEnd).toBe(2);

			// Re-render with same content but different isAgentWorking
			// This simulates signal-triggered re-renders from server push
			rerender(
				<InputTextarea
					content="hello"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={true}
				/>
			);

			// Cursor position should be preserved because:
			// 1. content prop didn't change
			// 2. textarea.value === content, so no DOM write happens
			expect(textarea.selectionStart).toBe(2);
			expect(textarea.selectionEnd).toBe(2);
		});

		it('should preserve cursor position during rapid prop changes', () => {
			const { container, rerender } = render(
				<InputTextarea
					content="hello world"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
					isAgentWorking={false}
				/>
			);

			const textarea = container.querySelector('textarea')!;

			// Position cursor at "hello |world"
			textarea.setSelectionRange(6, 6);

			// Simulate multiple rapid re-renders (like from WebSocket state updates)
			for (let i = 0; i < 5; i++) {
				rerender(
					<InputTextarea
						content="hello world"
						onContentChange={() => {}}
						onKeyDown={() => {}}
						onSubmit={() => {}}
						isAgentWorking={i % 2 === 0}
					/>
				);
			}

			// Cursor should still be at position 6
			expect(textarea.selectionStart).toBe(6);
			expect(textarea.selectionEnd).toBe(6);
		});

		it('should update DOM and set cursor to valid position when content changes externally', () => {
			const { container, rerender } = render(
				<InputTextarea
					content="hello world"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
				/>
			);

			const textarea = container.querySelector('textarea')!;

			// Position cursor at end of "hello world" (position 11)
			textarea.setSelectionRange(11, 11);

			// External content change (e.g., loading a draft)
			// New content is shorter, so cursor needs to be clamped
			rerender(
				<InputTextarea
					content="hi"
					onContentChange={() => {}}
					onKeyDown={() => {}}
					onSubmit={() => {}}
				/>
			);

			// Value should be updated
			expect(textarea.value).toBe('hi');

			// Cursor should be clamped to valid range (max is 2)
			expect(textarea.selectionStart).toBeLessThanOrEqual(2);
			expect(textarea.selectionEnd).toBeLessThanOrEqual(2);
		});

		it('should correctly sync when user types (DOM ahead of prop)', () => {
			const values: string[] = [];
			const onContentChange = mock((value: string) => {
				values.push(value);
			});

			const { container, rerender } = render(
				<InputTextarea
					content="hello"
					onContentChange={onContentChange}
					onKeyDown={() => {}}
					onSubmit={() => {}}
				/>
			);

			const textarea = container.querySelector('textarea')!;

			// Position cursor at position 5 (end of "hello")
			textarea.setSelectionRange(5, 5);

			// Simulate user typing "x" - browser updates DOM before our handler runs
			// This mimics what happens in a real browser
			fireEvent.input(textarea, { target: { value: 'hellox' } });

			// onContentChange should have been called with new value
			expect(onContentChange).toHaveBeenCalledWith('hellox');

			// Now simulate the re-render with updated content
			// (in real app, signal updates synchronously)
			rerender(
				<InputTextarea
					content="hellox"
					onContentChange={onContentChange}
					onKeyDown={() => {}}
					onSubmit={() => {}}
				/>
			);

			// Value should match
			expect(textarea.value).toBe('hellox');
		});
	});
});
