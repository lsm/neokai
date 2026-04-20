/**
 * Tests for CreateRoomModal — workspace path collection and validation
 */

import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal } from '@preact/signals';
import type { SystemState } from '@neokai/shared';
import { CreateRoomModal } from '../CreateRoomModal';

// Mock Portal to render inline
vi.mock('../../ui/Portal.tsx', () => ({
	Portal: ({ children }: { children: unknown }) => (
		<div data-portal="true">{children as never}</div>
	),
}));

// Mock systemState
const mockSystemStateSignal = signal<SystemState | null>(null);

vi.mock('../../../lib/state', () => ({
	get systemState() {
		return mockSystemStateSignal;
	},
}));

const DEFAULT_PROPS = {
	isOpen: true,
	onClose: vi.fn(),
	onSubmit: vi.fn().mockResolvedValue(undefined),
};

/** Returns the workspace path input (second text input after the name field). */
function getPathInput(): HTMLInputElement {
	const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"]'));
	// inputs[0] = Room Name, inputs[1] = Workspace Path
	const pathInput = inputs[1];
	if (!pathInput) throw new Error('Workspace path input not found');
	return pathInput;
}

describe('CreateRoomModal', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		mockSystemStateSignal.value = null;
	});

	afterEach(() => {
		cleanup();
		vi.resetAllMocks();
	});

	describe('rendering', () => {
		it('renders with workspace path field', () => {
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			const labels = Array.from(document.querySelectorAll('label'));
			expect(labels.some((l) => l.textContent?.includes('Workspace Path'))).toBe(true);
		});

		it('workspace path starts empty', () => {
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			expect(getPathInput().value).toBe('');
		});

		it('shows helper text for workspace path', () => {
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			expect(document.body.textContent).toContain("Filesystem path for this room's workspace");
		});

		it('shows required asterisk on workspace path label', () => {
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			const labels = Array.from(document.querySelectorAll('label'));
			const pathLabel = labels.find((l) => l.textContent?.includes('Workspace Path'));
			expect(pathLabel).toBeTruthy();
			expect(pathLabel?.querySelector('span')?.textContent).toBe('*');
		});
	});

	describe('form validation', () => {
		it('shows error if room name is empty on submit', async () => {
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);
			await waitFor(() => {
				expect(document.body.textContent).toContain('Room name is required');
			});
		});

		it('shows inline error if workspace path is empty on submit', async () => {
			render(<CreateRoomModal {...DEFAULT_PROPS} />);

			// Fill in room name
			const nameInput = document.querySelector<HTMLInputElement>('input[type="text"]')!;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			// Clear workspace path
			fireEvent.input(getPathInput(), { target: { value: '' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(document.body.textContent).toContain('Workspace path must not be empty');
			});
		});

		it('shows inline error if workspace path is relative on submit', async () => {
			render(<CreateRoomModal {...DEFAULT_PROPS} />);

			const nameInput = document.querySelector<HTMLInputElement>('input[type="text"]')!;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			fireEvent.input(getPathInput(), { target: { value: 'relative/path' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(document.body.textContent).toContain('absolute path');
			});
		});

		it('does not call onSubmit when workspace path is invalid', async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			render(<CreateRoomModal {...DEFAULT_PROPS} onSubmit={onSubmit} />);

			const nameInput = document.querySelector<HTMLInputElement>('input[type="text"]')!;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			fireEvent.input(getPathInput(), { target: { value: '' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(onSubmit).not.toHaveBeenCalled();
			});
		});
	});

	describe('successful submission', () => {
		it('calls onSubmit with name, defaultPath, and background', async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			render(<CreateRoomModal {...DEFAULT_PROPS} onSubmit={onSubmit} />);

			const nameInput = document.querySelector<HTMLInputElement>('input[type="text"]')!;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			fireEvent.input(getPathInput(), { target: { value: '/home/user/projects' } });

			const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
			fireEvent.input(textarea, { target: { value: 'Project background' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(onSubmit).toHaveBeenCalledWith({
					name: 'My Room',
					defaultPath: '/home/user/projects',
					background: 'Project background',
				});
			});
		});

		it('calls onSubmit without background when background is empty', async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			render(<CreateRoomModal {...DEFAULT_PROPS} onSubmit={onSubmit} />);

			const nameInput = document.querySelector<HTMLInputElement>('input[type="text"]')!;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			fireEvent.input(getPathInput(), { target: { value: '/home/user/projects' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(onSubmit).toHaveBeenCalledWith({
					name: 'My Room',
					defaultPath: '/home/user/projects',
					background: undefined,
				});
			});
		});

		it('calls onSubmit with custom workspace path', async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			render(<CreateRoomModal {...DEFAULT_PROPS} onSubmit={onSubmit} />);

			const nameInput = document.querySelector<HTMLInputElement>('input[type="text"]')!;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			fireEvent.input(getPathInput(), { target: { value: '/custom/workspace' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(onSubmit).toHaveBeenCalledWith(
					expect.objectContaining({ defaultPath: '/custom/workspace' })
				);
			});
		});
	});

	describe('form reset on close', () => {
		it('calls onClose when cancel is clicked', () => {
			const onClose = vi.fn();
			render(<CreateRoomModal {...DEFAULT_PROPS} onClose={onClose} />);

			const cancelBtn = Array.from(document.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Cancel'
			);
			expect(cancelBtn).toBeTruthy();
			fireEvent.click(cancelBtn!);

			expect(onClose).toHaveBeenCalled();
		});
	});
});
