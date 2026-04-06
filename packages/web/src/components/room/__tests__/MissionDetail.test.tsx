/**
 * Tests for MissionDetail Component
 *
 * Covers:
 * - Renders "Mission detail view — coming soon" placeholder text
 * - Renders "Back to Room" button text
 * - Clicking back button calls navigateToRoom with the correct roomId
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { MissionDetail } from '../MissionDetail';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigateToRoom = vi.fn();

vi.mock('../../../lib/router', () => ({
	navigateToRoom: (...args: unknown[]) => mockNavigateToRoom(...args),
}));

vi.mock('../ui/Button', () => ({
	Button: ({
		children,
		onClick,
	}: {
		children?: import('preact').ComponentChildren;
		onClick?: () => void;
		[key: string]: unknown;
	}) => <button onClick={onClick}>{children}</button>,
}));

vi.mock('../ui/MobileMenuButton', () => ({
	MobileMenuButton: () => <button data-testid="mobile-menu-button" />,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MissionDetail', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders "Mission detail view — coming soon" placeholder text', () => {
		const { container } = render(<MissionDetail roomId="room-1" goalId="goal-1" />);
		expect(container.textContent).toContain('Mission detail view — coming soon');
	});

	it('renders "Back to Room" button text', () => {
		const { container } = render(<MissionDetail roomId="room-1" goalId="goal-1" />);
		expect(container.textContent).toContain('Back to Room');
	});

	it('calls navigateToRoom with the correct roomId when back button is clicked', () => {
		const { container } = render(<MissionDetail roomId="room-1" goalId="goal-1" />);
		const buttons = container.querySelectorAll('button');
		const backButton = Array.from(buttons).find((b) => b.textContent?.includes('Back to Room'));
		expect(backButton).toBeTruthy();
		fireEvent.click(backButton!);
		expect(mockNavigateToRoom).toHaveBeenCalledOnce();
		expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
	});

	it('calls navigateToRoom with a different roomId when roomId prop changes', () => {
		const { container } = render(<MissionDetail roomId="room-42" goalId="goal-7" />);
		const buttons = container.querySelectorAll('button');
		const backButton = Array.from(buttons).find((b) => b.textContent?.includes('Back to Room'));
		fireEvent.click(backButton!);
		expect(mockNavigateToRoom).toHaveBeenCalledWith('room-42');
	});

	it('does not call navigateToRoom on initial render', () => {
		render(<MissionDetail roomId="room-1" goalId="goal-1" />);
		expect(mockNavigateToRoom).not.toHaveBeenCalled();
	});
});
