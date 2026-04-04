// @ts-nocheck
/**
 * Unit tests for AgentOverlayChat
 *
 * Tests:
 * - Renders with session ID — outer wrapper has data-testid="agent-overlay-chat"
 * - Shows agent name in header when agentName prop is provided
 * - Falls back to short session ID when agentName is not provided
 * - Close button calls onClose when clicked
 * - Escape key press calls onClose
 * - Backdrop click calls onClose
 * - Renders the session ID text in the header
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';

// Mock ChatContainer — it relies on WebSocket/stores not available in unit tests
vi.mock('../../../islands/ChatContainer', () => ({
	default: ({ sessionId }: { sessionId: string }) => (
		<div data-testid="mock-chat-container">{sessionId}</div>
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

	it('shows agentName in the header when agentName prop is provided', () => {
		const { getByTestId } = render(
			<AgentOverlayChat sessionId={SESSION_ID} agentName="My Agent" onClose={onClose} />
		);
		const nameEl = getByTestId('agent-overlay-name');
		expect(nameEl.textContent).toBe('My Agent');
	});

	it('falls back to short session ID (first 8 chars) when agentName is not provided', () => {
		const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		const nameEl = getByTestId('agent-overlay-name');
		expect(nameEl.textContent).toBe(SESSION_ID.slice(0, 8));
	});

	it('renders the full session ID text in the header', () => {
		const { getAllByText } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		// The session ID appears in the header <p> element (and also in the mock chat container)
		const matches = getAllByText(SESSION_ID);
		// At minimum one <p> element in the header should show the session ID
		const headerP = matches.find((el) => el.tagName.toLowerCase() === 'p');
		expect(headerP).toBeTruthy();
	});

	it('calls onClose when the close button is clicked', () => {
		const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		fireEvent.click(getByTestId('agent-overlay-close'));
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
		expect(chatContainer.textContent).toBe(SESSION_ID);
	});

	it('removes Escape key listener on unmount', () => {
		const { unmount } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
		unmount();
		// After unmount, pressing Escape should not call onClose
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).not.toHaveBeenCalled();
	});
});
