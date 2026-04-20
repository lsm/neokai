/**
 * Tests for TaskHeaderActions component
 *
 * Verifies that the reactivate and gear buttons render conditionally
 * and fire the correct callbacks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { TaskHeaderActions } from '../TaskHeaderActions';

describe('TaskHeaderActions', () => {
	beforeEach(() => cleanup());

	const defaultProps = {
		canReactivate: false,
		reactivating: false,
		onReactivate: vi.fn(),
		isInfoPanelOpen: false,
		onToggleInfoPanel: vi.fn(),
	};

	it('renders the gear (info panel trigger) button always', () => {
		const { getByTestId } = render(<TaskHeaderActions {...defaultProps} />);
		expect(getByTestId('task-info-panel-trigger')).not.toBeNull();
	});

	it('does not render reactivate button when canReactivate is false', () => {
		const { queryByTestId } = render(<TaskHeaderActions {...defaultProps} canReactivate={false} />);
		expect(queryByTestId('task-reactivate-button')).toBeNull();
	});

	it('renders reactivate button when canReactivate is true', () => {
		const { getByTestId } = render(<TaskHeaderActions {...defaultProps} canReactivate={true} />);
		expect(getByTestId('task-reactivate-button')).not.toBeNull();
	});

	it('calls onReactivate when reactivate button is clicked', () => {
		const onReactivate = vi.fn();
		const { getByTestId } = render(
			<TaskHeaderActions {...defaultProps} canReactivate={true} onReactivate={onReactivate} />
		);
		fireEvent.click(getByTestId('task-reactivate-button'));
		expect(onReactivate).toHaveBeenCalled();
	});

	it('shows reactivating text when reactivating is true', () => {
		const { getByTestId } = render(
			<TaskHeaderActions {...defaultProps} canReactivate={true} reactivating={true} />
		);
		expect(getByTestId('task-reactivate-button').textContent).toContain('Reactivating');
	});

	it('calls onToggleInfoPanel when gear button is clicked', () => {
		const onToggleInfoPanel = vi.fn();
		const { getByTestId } = render(
			<TaskHeaderActions {...defaultProps} onToggleInfoPanel={onToggleInfoPanel} />
		);
		fireEvent.click(getByTestId('task-info-panel-trigger'));
		expect(onToggleInfoPanel).toHaveBeenCalled();
	});

	it('applies active style to gear button when isInfoPanelOpen is true', () => {
		const { getByTestId } = render(<TaskHeaderActions {...defaultProps} isInfoPanelOpen={true} />);
		const btn = getByTestId('task-info-panel-trigger');
		expect(btn.className).toContain('bg-blue-600');
	});

	// --- Tap target sizing (36px minimum for mobile) ---

	it('gear button has 36px minimum tap target width and height', () => {
		const { getByTestId } = render(<TaskHeaderActions {...defaultProps} />);
		const btn = getByTestId('task-info-panel-trigger');
		expect(btn.className).toContain('min-w-[36px]');
		expect(btn.className).toContain('min-h-[36px]');
	});
});
