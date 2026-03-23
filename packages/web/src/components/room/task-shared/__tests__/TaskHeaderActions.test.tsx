/**
 * Tests for TaskHeaderActions component
 *
 * Verifies that the stop, reactivate, and gear buttons render conditionally
 * and fire the correct callbacks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { TaskHeaderActions } from '../TaskHeaderActions';

describe('TaskHeaderActions', () => {
	beforeEach(() => cleanup());

	const defaultProps = {
		canInterrupt: false,
		interrupting: false,
		onInterrupt: vi.fn(),
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

	it('does not render stop button when canInterrupt is false', () => {
		const { queryByTestId } = render(<TaskHeaderActions {...defaultProps} canInterrupt={false} />);
		expect(queryByTestId('task-stop-button')).toBeNull();
	});

	it('renders stop button when canInterrupt is true', () => {
		const { getByTestId } = render(<TaskHeaderActions {...defaultProps} canInterrupt={true} />);
		expect(getByTestId('task-stop-button')).not.toBeNull();
	});

	it('calls onInterrupt when stop button is clicked', () => {
		const onInterrupt = vi.fn();
		const { getByTestId } = render(
			<TaskHeaderActions {...defaultProps} canInterrupt={true} onInterrupt={onInterrupt} />
		);
		fireEvent.click(getByTestId('task-stop-button'));
		expect(onInterrupt).toHaveBeenCalled();
	});

	it('disables stop button when interrupting is true', () => {
		const { getByTestId } = render(
			<TaskHeaderActions {...defaultProps} canInterrupt={true} interrupting={true} />
		);
		expect((getByTestId('task-stop-button') as HTMLButtonElement).disabled).toBe(true);
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
});
