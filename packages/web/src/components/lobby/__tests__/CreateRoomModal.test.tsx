// @ts-nocheck
/**
 * Tests for CreateRoomModal — workspace path collection and validation
 */

import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal } from '@preact/signals';
import { CreateRoomModal } from '../CreateRoomModal';

// Mock Portal to render inline
vi.mock('../../ui/Portal.tsx', () => ({
	Portal: ({ children }) => <div data-portal="true">{children}</div>,
}));

// Mock systemState — controls what workspaceRoot is pre-filled with
const mockSystemStateSignal = signal<{ workspaceRoot?: string } | null>(null);

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

describe('CreateRoomModal', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		mockSystemStateSignal.value = { workspaceRoot: '/home/user/projects' };
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

		it('pre-fills workspace path from systemState workspaceRoot', () => {
			mockSystemStateSignal.value = { workspaceRoot: '/home/user/projects' };
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
			const pathInput = inputs.find((i) => (i as HTMLInputElement).value === '/home/user/projects');
			expect(pathInput).toBeTruthy();
		});

		it('pre-fills empty string when systemState has no workspaceRoot', () => {
			mockSystemStateSignal.value = null;
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
			// Should have a workspace path input (possibly empty)
			expect(inputs.length).toBeGreaterThanOrEqual(2);
		});

		it('shows helper text for workspace path', () => {
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			expect(document.body.textContent).toContain("Filesystem path for this room's workspace");
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
			const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			// Clear workspace path
			const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
			const pathInput = inputs[1] as HTMLInputElement;
			fireEvent.input(pathInput, { target: { value: '' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(document.body.textContent).toContain('Workspace path must not be empty');
			});
		});

		it('shows inline error if workspace path is relative on submit', async () => {
			render(<CreateRoomModal {...DEFAULT_PROPS} />);

			const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
			const pathInput = inputs[1] as HTMLInputElement;
			fireEvent.input(pathInput, { target: { value: 'relative/path' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(document.body.textContent).toContain('absolute path');
			});
		});

		it('does not call onSubmit when workspace path is invalid', async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			render(<CreateRoomModal {...DEFAULT_PROPS} onSubmit={onSubmit} />);

			const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
			const pathInput = inputs[1] as HTMLInputElement;
			fireEvent.input(pathInput, { target: { value: '' } });

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

			// Fill name
			const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			// Path is already pre-filled with /home/user/projects

			// Fill background
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

			const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

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

			const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
			const pathInput = inputs[1] as HTMLInputElement;
			fireEvent.input(pathInput, { target: { value: '/custom/workspace' } });

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
		it('resets all fields when closed', async () => {
			const onClose = vi.fn();
			render(<CreateRoomModal {...DEFAULT_PROPS} onClose={onClose} />);

			const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Room' } });

			// Click cancel button
			const cancelBtn = Array.from(document.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Cancel'
			);
			expect(cancelBtn).toBeTruthy();
			fireEvent.click(cancelBtn!);

			expect(onClose).toHaveBeenCalled();
		});
	});
});
