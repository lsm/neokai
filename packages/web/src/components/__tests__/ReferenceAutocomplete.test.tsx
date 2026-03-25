// @ts-nocheck
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReferenceAutocomplete from '../ReferenceAutocomplete';
import type { ReferenceSearchResult } from '@neokai/shared';

const TASK_RESULT: ReferenceSearchResult = {
	type: 'task',
	id: 't-42',
	shortId: 't-42',
	displayText: 'Fix the login bug',
	subtitle: 'in progress',
};

const FILE_RESULT: ReferenceSearchResult = {
	type: 'file',
	id: 'src/auth.ts',
	displayText: 'src/auth.ts',
};

const GOAL_RESULT: ReferenceSearchResult = {
	type: 'goal',
	id: 'g-7',
	shortId: 'g-7',
	displayText: 'Launch v2',
	subtitle: 'measurable',
};

const FOLDER_RESULT: ReferenceSearchResult = {
	type: 'folder',
	id: 'src',
	displayText: 'src',
};

describe('ReferenceAutocomplete', () => {
	beforeEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe('rendering', () => {
		it('renders nothing when results is empty', () => {
			const { container } = render(
				<ReferenceAutocomplete
					results={[]}
					selectedIndex={0}
					onSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('renders all result items', () => {
			const { getAllByRole } = render(
				<ReferenceAutocomplete
					results={[TASK_RESULT, FILE_RESULT]}
					selectedIndex={0}
					onSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			const buttons = getAllByRole('button');
			expect(buttons).toHaveLength(2);
		});

		it('renders display text for each result', () => {
			const { getByText } = render(
				<ReferenceAutocomplete
					results={[TASK_RESULT, FILE_RESULT]}
					selectedIndex={0}
					onSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(getByText('Fix the login bug')).toBeTruthy();
			expect(getByText('src/auth.ts')).toBeTruthy();
		});

		it('renders subtitle when present', () => {
			const { getByText } = render(
				<ReferenceAutocomplete
					results={[TASK_RESULT]}
					selectedIndex={0}
					onSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(getByText('in progress')).toBeTruthy();
		});

		it('renders shortId when present', () => {
			const { getByText } = render(
				<ReferenceAutocomplete
					results={[TASK_RESULT]}
					selectedIndex={0}
					onSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(getByText('t-42')).toBeTruthy();
		});

		it('renders header with @ References label', () => {
			const { getByText } = render(
				<ReferenceAutocomplete
					results={[TASK_RESULT]}
					selectedIndex={0}
					onSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(getByText('References')).toBeTruthy();
		});

		it('applies selected style to the active item', () => {
			const { getAllByRole } = render(
				<ReferenceAutocomplete
					results={[TASK_RESULT, FILE_RESULT]}
					selectedIndex={1}
					onSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			const buttons = getAllByRole('button');
			expect(buttons[1].className).toContain('border-blue-500');
			expect(buttons[0].className).not.toContain('border-blue-500');
		});

		it('renders all four reference types', () => {
			const { getAllByRole } = render(
				<ReferenceAutocomplete
					results={[TASK_RESULT, GOAL_RESULT, FILE_RESULT, FOLDER_RESULT]}
					selectedIndex={0}
					onSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			);
			expect(getAllByRole('button')).toHaveLength(4);
		});
	});

	describe('interaction', () => {
		it('calls onSelect with the result when a button is clicked', () => {
			const onSelect = vi.fn();
			const { getAllByRole } = render(
				<ReferenceAutocomplete
					results={[TASK_RESULT, FILE_RESULT]}
					selectedIndex={0}
					onSelect={onSelect}
					onClose={vi.fn()}
				/>
			);
			fireEvent.click(getAllByRole('button')[1]);
			expect(onSelect).toHaveBeenCalledOnce();
			expect(onSelect).toHaveBeenCalledWith(FILE_RESULT);
		});

		it('calls onClose when clicking outside the menu', () => {
			const onClose = vi.fn();
			render(
				<ReferenceAutocomplete
					results={[TASK_RESULT]}
					selectedIndex={0}
					onSelect={vi.fn()}
					onClose={onClose}
				/>
			);
			fireEvent.mouseDown(document.body);
			expect(onClose).toHaveBeenCalledOnce();
		});

		it('does not call onClose when clicking inside the menu', () => {
			const onClose = vi.fn();
			const { getAllByRole } = render(
				<ReferenceAutocomplete
					results={[TASK_RESULT]}
					selectedIndex={0}
					onSelect={vi.fn()}
					onClose={onClose}
				/>
			);
			fireEvent.mouseDown(getAllByRole('button')[0]);
			expect(onClose).not.toHaveBeenCalled();
		});
	});
});
