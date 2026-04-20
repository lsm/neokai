// @ts-nocheck
/**
 * Unit tests for AgentOverlayChat
 *
 * The overlay no longer renders its own header — the embedded `ChatContainer`
 * owns the single header, with its left-slot back button (opted in via
 * `onBack`) acting as the dismiss control. These tests verify:
 * - The outer wrapper dialog renders with `data-testid="agent-overlay-chat"`.
 * - The aria-label reflects `agentName` (or falls back to "Agent chat") so
 *   screen readers identify which agent is open.
 * - `ChatContainer` receives both `sessionId` and an `onBack` callback.
 * - Clicking the back button surfaced by ChatContainer invokes `onClose`.
 * - Escape key press invokes `onClose` (only once, only on Escape).
 * - Backdrop click invokes `onClose`.
 * - Escape listener is removed on unmount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';

// Mock ChatContainer — it relies on WebSocket/stores not available in unit
// tests. Expose `onBack` via a data-attribute so tests can assert it was
// forwarded, and render a button that invokes it so the dismiss path through
// ChatContainer's header is covered end-to-end.
vi.mock('../../../islands/ChatContainer', () => ({
	default: ({ sessionId, onBack }: { sessionId: string; onBack?: () => void }) => (
		<div data-testid="mock-chat-container" data-has-on-back={onBack ? '1' : '0'}>
			<button type="button" data-testid="mock-chat-header-back" onClick={onBack}>
				back
			</button>
			{sessionId}
		</div>
	),
}));

// Mock cn utility
vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { AgentOverlayChat } from '../AgentOverlayChat';

const SESSION_ID = 'abcdef12-0000-0000-0000-000000000000';

describe('AgentOverlayChat', () => {
	let onClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		cleanup();
		onClose = vi.fn();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders the overlay wrapper with correct data-testid', () => {
		const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		expect(getByTestId('agent-overlay-chat')).toBeTruthy();
	});

	it('reflects agentName in the dialog aria-label for screen readers', () => {
		const { getByTestId } = render(
			<AgentOverlayChat sessionId={SESSION_ID} agentName="My Agent" onClose={onClose} />
		);
		expect(getByTestId('agent-overlay-chat').getAttribute('aria-label')).toBe('My Agent chat');
	});

	it('falls back to a generic "Agent chat" aria-label when agentName is not provided', () => {
		const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		expect(getByTestId('agent-overlay-chat').getAttribute('aria-label')).toBe('Agent chat');
	});

	it('forwards onBack to ChatContainer so its header back button dismisses the overlay', () => {
		const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		expect(getByTestId('mock-chat-container').getAttribute('data-has-on-back')).toBe('1');
		fireEvent.click(getByTestId('mock-chat-header-back'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('calls onClose when Escape key is pressed', () => {
		render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('does not call onClose for non-Escape key presses', () => {
		render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		fireEvent.keyDown(document, { key: 'Enter' });
		fireEvent.keyDown(document, { key: 'a' });
		expect(onClose).not.toHaveBeenCalled();
	});

	it('calls onClose when backdrop is clicked', () => {
		const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		// The backdrop is the first child of the overlay wrapper (aria-hidden div)
		const overlay = getByTestId('agent-overlay-chat');
		const backdrop = overlay.querySelector('[aria-hidden="true"]');
		expect(backdrop).toBeTruthy();
		fireEvent.click(backdrop!);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('renders the mock ChatContainer with the provided sessionId', () => {
		const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		const chatContainer = getByTestId('mock-chat-container');
		expect(chatContainer).toBeTruthy();
		expect(chatContainer.textContent).toContain(SESSION_ID);
	});

	it('removes Escape key listener on unmount', () => {
		const { unmount } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		unmount();
		// After unmount, pressing Escape should not call onClose
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).not.toHaveBeenCalled();
	});
});
