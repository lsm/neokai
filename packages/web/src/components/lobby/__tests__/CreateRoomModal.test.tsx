/**
 * Tests for CreateRoomModal — workspace path collection and validation
 */

import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/preact';
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

// Mock systemState — controls what workspaceRoot is pre-filled with.
// Typed as a plain writable signal so tests can update it directly.
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
		mockSystemStateSignal.value = { workspaceRoot: '/home/user/projects' } as SystemState;
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
			mockSystemStateSignal.value = { workspaceRoot: '/home/user/projects' } as SystemState;
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			expect(getPathInput().value).toBe('/home/user/projects');
		});

		it('pre-fills empty string when systemState is null', () => {
			mockSystemStateSignal.value = null;
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			expect(getPathInput().value).toBe('');
		});

		it('pre-fills empty string when systemState.workspaceRoot is undefined', () => {
			// workspaceRoot is optional on SystemState — daemon may omit it
			mockSystemStateSignal.value = {} as SystemState;
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

	describe('systemState late-arrival sync', () => {
		it('updates workspace path when systemState arrives after mount', async () => {
			mockSystemStateSignal.value = null;
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			// Initially empty
			expect(getPathInput().value).toBe('');

			// systemState arrives
			await act(async () => {
				mockSystemStateSignal.value = { workspaceRoot: '/late/arrival' } as SystemState;
			});

			expect(getPathInput().value).toBe('/late/arrival');
		});

		it('leaves path empty when late-arriving systemState has no workspaceRoot', async () => {
			mockSystemStateSignal.value = null;
			render(<CreateRoomModal {...DEFAULT_PROPS} />);
			expect(getPathInput().value).toBe('');

			// State arrives but without workspaceRoot
			await act(async () => {
				mockSystemStateSignal.value = {} as SystemState;
			});

			expect(getPathInput().value).toBe('');
		});

		it('does not overwrite user-edited path when systemState changes', async () => {
			mockSystemStateSignal.value = null;
			render(<CreateRoomModal {...DEFAULT_PROPS} />);

			// User types a custom path
			const pathInput = getPathInput();
			fireEvent.input(pathInput, { target: { value: '/my/custom/path' } });
			expect(pathInput.value).toBe('/my/custom/path');

			// systemState arrives — must not overwrite user's input
			await act(async () => {
				mockSystemStateSignal.value = { workspaceRoot: '/server/path' } as SystemState;
			});

			expect(getPathInput().value).toBe('/my/custom/path');
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

			// Fill name
			const nameInput = document.querySelector<HTMLInputElement>('input[type="text"]')!;
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

			const nameInput = document.querySelector<HTMLInputElement>('input[type="text"]')!;
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
