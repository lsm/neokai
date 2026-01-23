// @ts-nocheck
/**
 * Tests for RewindModal Component
 */

import { render, cleanup, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RewindModal } from '../RewindModal';
import type { Checkpoint, RewindPreview } from '@liuboer/shared';

// Mock API helpers (path relative to __tests__ folder)
vi.mock('../../lib/api-helpers', () => ({
	getCheckpoints: vi.fn(),
	previewRewind: vi.fn(),
	executeRewind: vi.fn(),
}));

// Mock toast
vi.mock('../../lib/toast', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock errors
vi.mock('../../lib/errors', () => ({
	ConnectionNotReadyError: class extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ConnectionNotReadyError';
		}
	},
}));

// Mock borderColors
vi.mock('../../lib/design-tokens', () => ({
	borderColors: {
		ui: {
			default: 'border-gray-700',
		},
	},
}));

// Mock cn utility
vi.mock('../../lib/utils', () => ({
	cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

import { getCheckpoints, previewRewind, executeRewind } from '../../lib/api-helpers';
import { toast } from '../../lib/toast';

function createMockCheckpoints(count: number): Checkpoint[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `checkpoint-${i + 1}`,
		messagePreview: `User message ${i + 1}`,
		turnNumber: i + 1,
		timestamp: Date.now() - (count - i) * 60000, // Spaced by minute
		sessionId: 'test-session-id',
	}));
}

function createMockPreview(overrides: Partial<RewindPreview> = {}): RewindPreview {
	return {
		canRewind: true,
		filesChanged: ['src/file1.ts', 'src/file2.ts'],
		insertions: 100,
		deletions: 50,
		...overrides,
	};
}

describe('RewindModal', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
		document.body.style.overflow = '';
	});

	describe('Rendering - closed state', () => {
		it('should not render when isOpen is false', () => {
			render(<RewindModal isOpen={false} onClose={() => {}} sessionId="test-session" />);

			const modal = document.body.querySelector('[role="dialog"]');
			expect(modal).toBeNull();
		});

		it('should not render when sessionId is null', () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId={null} />);

			const modal = document.body.querySelector('[role="dialog"]');
			expect(modal).toBeNull();
		});
	});

	describe('Rendering - loading state', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockImplementation(
				() => new Promise((resolve) => setTimeout(() => resolve({ checkpoints: [] }), 100))
			);
		});

		it('should render loading spinner when loading checkpoints', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			// Should show loading spinner
			const spinner = document.body.querySelector('.animate-spin');
			expect(spinner).toBeTruthy();
		});
	});

	describe('Rendering - empty state', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: [] });
		});

		it('should render empty state when no checkpoints available', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				const emptyState = document.body.querySelector('p');
				expect(emptyState?.textContent).toContain('No checkpoints available');
			});
		});

		it('should show helpful message about how checkpoints are created', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				const message = Array.from(document.body.querySelectorAll('p')).find(
					(p) => p.textContent === 'Checkpoints are created when you send messages to the agent.'
				);
				expect(message).toBeTruthy();
			});
		});
	});

	describe('Rendering - checkpoints list', () => {
		beforeEach(() => {
			const checkpoints = createMockCheckpoints(3);
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints });
			vi.mocked(previewRewind).mockResolvedValue({ preview: createMockPreview() });
		});

		it('should render checkpoint list', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				const buttons = document.body.querySelectorAll('button');
				// Find checkpoint buttons by looking for turn numbers
				const checkpointButtons = Array.from(buttons).filter((btn) =>
					btn.textContent?.includes('Turn')
				);
				expect(checkpointButtons.length).toBe(3);
			});
		});

		it('should render checkpoints sorted by turn number (newest first)', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				const buttons = document.body.querySelectorAll('button');
				const turnNumbers = Array.from(buttons)
					.filter((btn) => btn.textContent?.includes('Turn'))
					.map((btn) => btn.textContent?.match(/Turn (\d+)/)?.[1]);

				// Should be sorted: Turn 3, Turn 2, Turn 1
				expect(turnNumbers).toEqual(['3', '2', '1']);
			});
		});

		it('should display message preview for each checkpoint', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				const checkpoints = document.body.querySelectorAll('p.text-sm');
				const previews = Array.from(checkpoints).filter((p) =>
					p.textContent?.includes('User message')
				);
				expect(previews.length).toBe(3);
			});
		});
	});

	describe('Mode selection', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: createMockCheckpoints(2) });
			vi.mocked(previewRewind).mockResolvedValue({ preview: createMockPreview() });
		});

		it('should render three mode options', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				const labels = document.body.querySelectorAll('span.text-sm');
				const modeLabels = Array.from(labels).filter((l) =>
					l.textContent?.match(/(Files only|Conversation only|Both)/)
				);
				expect(modeLabels.length).toBe(3);
			});
		});

		it('should have files mode selected by default', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				const radioInputs = document.body.querySelectorAll('input[type="radio"]');
				const filesRadio = Array.from(radioInputs).find(
					(input) => input.getAttribute('value') === 'files' && (input as HTMLInputElement).checked
				);
				expect(filesRadio).toBeTruthy();
			});
		});

		it('should respect initialMode prop', async () => {
			render(
				<RewindModal
					isOpen={true}
					onClose={() => {}}
					sessionId="test-session"
					initialMode="conversation"
				/>
			);

			await waitFor(() => {
				const radioInputs = document.body.querySelectorAll('input[type="radio"]');
				const conversationRadio = Array.from(radioInputs).find(
					(input) =>
						input.getAttribute('value') === 'conversation' && (input as HTMLInputElement).checked
				);
				expect(conversationRadio).toBeTruthy();
			});
		});
	});

	describe('Mode descriptions', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: createMockCheckpoints(1) });
		});

		it('should show correct description for files mode', async () => {
			render(
				<RewindModal
					isOpen={true}
					onClose={() => {}}
					sessionId="test-session"
					initialMode="files"
				/>
			);

			await waitFor(() => {
				const description = document.body.querySelector('p.text-sm.text-gray-400');
				expect(description?.textContent).toContain('Restore file changes only');
			});
		});

		it('should show correct description for conversation mode', async () => {
			render(
				<RewindModal
					isOpen={true}
					onClose={() => {}}
					sessionId="test-session"
					initialMode="conversation"
				/>
			);

			await waitFor(() => {
				const description = document.body.querySelector('p.text-sm.text-gray-400');
				expect(description?.textContent).toContain('Resume conversation from this point');
			});
		});

		it('should show correct description for both mode', async () => {
			render(
				<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" initialMode="both" />
			);

			await waitFor(() => {
				const description = document.body.querySelector('p.text-sm.text-gray-400');
				expect(description?.textContent).toContain('Restore both files and conversation');
			});
		});
	});

	describe('Checkpoint selection and preview', () => {
		const mockCheckpoints = createMockCheckpoints(3);
		const mockPreview = createMockPreview();

		// Helper to click on first checkpoint
		function clickFirstCheckpoint() {
			const buttons = document.body.querySelectorAll('button');
			const firstCheckpoint = Array.from(buttons).find((btn) =>
				btn.textContent?.includes('Turn 3')
			);
			if (firstCheckpoint) {
				firstCheckpoint.click();
			}
		}

		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: mockCheckpoints });
			vi.mocked(previewRewind).mockResolvedValue({ preview: mockPreview });
		});

		it('should load preview when checkpoint is clicked', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await clickFirstCheckpoint();

			expect(vi.mocked(previewRewind)).toHaveBeenCalledWith('test-session', 'checkpoint-3');
		});

		it('should display preview panel with file changes', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			clickFirstCheckpoint();

			await waitFor(() => {
				const previewHeader = Array.from(document.body.querySelectorAll('h4')).find(
					(h) => h.textContent === 'Preview'
				);
				expect(previewHeader).toBeTruthy();
			});
		});

		it('should display file count in preview', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			clickFirstCheckpoint();

			await waitFor(() => {
				const fileCount = Array.from(document.body.querySelectorAll('span')).find((s) =>
					s.textContent?.includes('Files changed:')
				);
				expect(fileCount?.nextSibling?.textContent).toContain('2');
			});
		});

		it('should display insertions and deletions counts', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			clickFirstCheckpoint();

			await waitFor(() => {
				const insertions = Array.from(document.body.querySelectorAll('span')).find((s) =>
					s.classList.contains('text-green-400')
				);
				const deletions = Array.from(document.body.querySelectorAll('span')).find((s) =>
					s.classList.contains('text-red-400')
				);
				expect(insertions?.textContent).toBe('+100');
				expect(deletions?.textContent).toBe('-50');
			});
		});

		it('should display list of files to restore', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			clickFirstCheckpoint();

			await waitFor(() => {
				const file1 = Array.from(document.body.querySelectorAll('div')).find(
					(d) => d.textContent === 'src/file1.ts'
				);
				const file2 = Array.from(document.body.querySelectorAll('div')).find(
					(d) => d.textContent === 'src/file2.ts'
				);
				expect(file1).toBeTruthy();
				expect(file2).toBeTruthy();
			});
		});
	});

	describe('Preview error states', () => {
		const mockCheckpoints = createMockCheckpoints(1);

		// Helper to click on first checkpoint
		async function clickCheckpointForErrorTests() {
			const buttons = document.body.querySelectorAll('button');
			const firstCheckpoint = Array.from(buttons).find((btn) =>
				btn.textContent?.includes('Turn 1')
			);
			if (firstCheckpoint) {
				firstCheckpoint.click();
			}
		}

		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: mockCheckpoints });
		});

		it('should display error when preview cannot be generated', async () => {
			vi.mocked(previewRewind).mockResolvedValue({
				preview: {
					canRewind: false,
					error: 'Cannot rewind: no file changes',
				},
			});

			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			// Click on checkpoint to trigger preview load
			await waitFor(() => clickCheckpointForErrorTests());

			await waitFor(() => {
				const errorDiv = document.body.querySelector('.bg-yellow-500\\/10');
				expect(errorDiv?.textContent).toContain('Cannot rewind: no file changes');
			});
		});

		it('should disable rewind button when preview fails', async () => {
			vi.mocked(previewRewind).mockResolvedValue({
				preview: {
					canRewind: false,
					error: 'Cannot rewind',
				},
			});

			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			// Click on checkpoint to trigger preview load
			await waitFor(() => clickCheckpointForErrorTests());

			await waitFor(() => {
				const rewindButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Rewind'
				);
				expect(rewindButton?.getAttribute('disabled')).toBeTruthy();
			});
		});
	});

	describe('Execute rewind - files mode', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: createMockCheckpoints(1) });
			vi.mocked(previewRewind).mockResolvedValue({ preview: createMockPreview() });
			vi.mocked(executeRewind).mockResolvedValue({
				result: {
					success: true,
					filesChanged: ['src/file1.ts'],
					insertions: 50,
					deletions: 25,
				},
			});
		});

		it('should execute rewind when rewind button is clicked', async () => {
			const onClose = vi.fn();
			render(<RewindModal isOpen={true} onClose={onClose} sessionId="test-session" />);

			await waitFor(() => {
				const rewindButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Rewind'
				);
				rewindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			await waitFor(() => {
				expect(vi.mocked(executeRewind)).toHaveBeenCalledWith(
					'test-session',
					'checkpoint-1',
					'files'
				);
				expect(toast.success).toHaveBeenCalledWith(
					expect.stringContaining('Rewound files to checkpoint')
				);
				expect(onClose).toHaveBeenCalled();
			});
		});
	});

	describe('Execute rewind - conversation mode', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: createMockCheckpoints(1) });
			vi.mocked(previewRewind).mockResolvedValue({ preview: createMockPreview() });
			vi.mocked(executeRewind).mockResolvedValue({
				result: {
					success: true,
					filesChanged: [],
					conversationRewound: true,
					messagesDeleted: 5,
				},
			});
		});

		it('should show confirmation dialog for conversation mode', async () => {
			render(
				<RewindModal
					isOpen={true}
					onClose={() => {}}
					sessionId="test-session"
					initialMode="conversation"
				/>
			);

			// Wait for checkpoints to load
			await waitFor(() => {
				const checkpoints = document.body.querySelectorAll('button');
				expect(checkpoints.length).toBeGreaterThan(0);
			});

			// Click rewind button
			const rewindButton = Array.from(document.body.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Rewind'
			);
			rewindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			// Should show confirmation
			await waitFor(() => {
				const confirmation = document.body.querySelector('.bg-red-500\\/10');
				expect(confirmation?.textContent).toContain('cannot be undone');
			});
		});

		it('should execute conversation rewind after confirmation', async () => {
			const onClose = vi.fn();
			render(
				<RewindModal
					isOpen={true}
					onClose={onClose}
					sessionId="test-session"
					initialMode="conversation"
				/>
			);

			// Wait for checkpoints to load and click rewind
			await waitFor(() => {
				const rewindButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Rewind'
				);
				rewindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			// Click confirm button
			await waitFor(() => {
				const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Confirm Rewind'
				);
				confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			await waitFor(() => {
				expect(vi.mocked(executeRewind)).toHaveBeenCalledWith(
					'test-session',
					'checkpoint-1',
					'conversation'
				);
				expect(toast.success).toHaveBeenCalledWith('Rewound conversation to checkpoint');
				expect(onClose).toHaveBeenCalled();
			});
		});

		it('should cancel rewind when cancel button is clicked', async () => {
			render(
				<RewindModal
					isOpen={true}
					onClose={() => {}}
					sessionId="test-session"
					initialMode="conversation"
				/>
			);

			// Click rewind button
			await waitFor(() => {
				const rewindButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Rewind'
				);
				rewindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			// Click cancel button
			await waitFor(() => {
				const cancelButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Cancel' && btn.closest('.bg-red-500\\/10')
				);
				cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			await waitFor(() => {
				expect(vi.mocked(executeRewind)).not.toHaveBeenCalled();
			});
		});
	});

	describe('Execute rewind - both mode', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: createMockCheckpoints(1) });
			vi.mocked(previewRewind).mockResolvedValue({ preview: createMockPreview() });
			vi.mocked(executeRewind).mockResolvedValue({
				result: {
					success: true,
					filesChanged: ['src/file1.ts'],
					insertions: 50,
					deletions: 25,
					conversationRewound: true,
					messagesDeleted: 3,
				},
			});
		});

		it('should show confirmation for both mode', async () => {
			render(
				<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" initialMode="both" />
			);

			await waitFor(() => {
				const rewindButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Rewind'
				);
				rewindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			await waitFor(() => {
				const confirmation = document.body.querySelector('.bg-red-500\\/10');
				expect(confirmation?.textContent).toContain('cannot be undone');
			});
		});

		it('should execute both mode rewind after confirmation', async () => {
			const onClose = vi.fn();
			render(
				<RewindModal isOpen={true} onClose={onClose} sessionId="test-session" initialMode="both" />
			);

			// Click rewind
			await waitFor(() => {
				const rewindButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Rewind'
				);
				rewindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			// Click confirm
			await waitFor(() => {
				const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Confirm Rewind'
				);
				confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			await waitFor(() => {
				expect(vi.mocked(executeRewind)).toHaveBeenCalledWith(
					'test-session',
					'checkpoint-1',
					'both'
				);
				expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('files + conversation'));
				expect(onClose).toHaveBeenCalled();
			});
		});
	});

	describe('Error handling', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: createMockCheckpoints(1) });
			vi.mocked(previewRewind).mockResolvedValue({ preview: createMockPreview() });
		});

		it('should display error when getCheckpoints fails', async () => {
			vi.mocked(getCheckpoints).mockResolvedValue({
				checkpoints: [],
				error: 'Failed to load checkpoints',
			});

			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				const errorDiv = document.body.querySelector('.bg-red-500\\/10');
				expect(errorDiv?.textContent).toContain('Failed to load checkpoints');
			});
		});

		it('should display error when executeRewind fails', async () => {
			vi.mocked(executeRewind).mockResolvedValue({
				result: {
					success: false,
					error: 'Rewind failed',
				},
			});

			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			// Click rewind button
			await waitFor(() => {
				const rewindButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Rewind'
				);
				rewindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			await waitFor(() => {
				expect(toast.error).toHaveBeenCalledWith('Rewind failed');
			});
		});

		it('should handle ConnectionNotReadyError from getCheckpoints', async () => {
			const { ConnectionNotReadyError } = await import('../../lib/errors');
			vi.mocked(getCheckpoints).mockRejectedValue(new ConnectionNotReadyError('Not connected'));

			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				const errorDiv = document.body.querySelector('.bg-red-500\\/10');
				expect(errorDiv?.textContent).toContain('Not connected to server');
			});
		});

		it('should handle ConnectionNotReadyError from previewRewind', async () => {
			const { ConnectionNotReadyError } = await import('../../lib/errors');
			vi.mocked(previewRewind).mockRejectedValue(new ConnectionNotReadyError('Not connected'));

			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			// Wait for checkpoint selection
			await waitFor(() => {
				const checkpoints = document.body.querySelectorAll('button');
				expect(checkpoints.length).toBeGreaterThan(0);
			});

			// Check if toast.error was called
			await waitFor(
				() => {
					expect(toast.error).toHaveBeenCalledWith('Not connected to server');
				},
				{ timeout: 5000 }
			);
		});
	});

	describe('Preselected checkpoint', () => {
		beforeEach(() => {
			const checkpoints = createMockCheckpoints(3);
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints });
			vi.mocked(previewRewind).mockResolvedValue({ preview: createMockPreview() });
		});

		it('should load preview for preselected checkpoint', async () => {
			render(
				<RewindModal
					isOpen={true}
					onClose={() => {}}
					sessionId="test-session"
					preselectedCheckpointId="checkpoint-2"
				/>
			);

			await waitFor(() => {
				// Should have called previewRewind for checkpoint-2
				expect(vi.mocked(previewRewind)).toHaveBeenCalledWith('test-session', 'checkpoint-2');
			});
		});
	});

	describe('Modal interactions', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: createMockCheckpoints(1) });
			vi.mocked(previewRewind).mockResolvedValue({ preview: createMockPreview() });
		});

		it('should call onClose when close button is clicked', async () => {
			const onClose = vi.fn();
			render(<RewindModal isOpen={true} onClose={onClose} sessionId="test-session" />);

			await waitFor(() => {
				const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
				closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			expect(onClose).toHaveBeenCalled();
		});

		it('should call onClose when cancel button is clicked', async () => {
			const onClose = vi.fn();
			render(<RewindModal isOpen={true} onClose={onClose} sessionId="test-session" />);

			await waitFor(() => {
				const cancelButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Cancel' && !btn.closest('.bg-red-500\\/10')
				);
				cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			expect(onClose).toHaveBeenCalled();
		});

		it('should reset state when modal is closed and reopened', async () => {
			const { rerender } = render(
				<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />
			);

			// Wait for initial load
			await waitFor(() => {
				expect(vi.mocked(getCheckpoints)).toHaveBeenCalledTimes(1);
			});

			// Close modal
			rerender(<RewindModal isOpen={false} onClose={() => {}} sessionId="test-session" />);

			// Reopen modal
			vi.clearAllMocks();
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: createMockCheckpoints(1) });
			rerender(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				expect(vi.mocked(getCheckpoints)).toHaveBeenCalled();
			});
		});
	});

	describe('No file changes preview', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: createMockCheckpoints(1) });
			vi.mocked(previewRewind).mockResolvedValue({
				preview: {
					canRewind: true,
					filesChanged: [],
					insertions: 0,
					deletions: 0,
				},
			});
		});

		it('should show message when no file changes to revert', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			await waitFor(() => {
				const message = Array.from(document.body.querySelectorAll('p')).find(
					(p) => p.textContent === 'No file changes to revert'
				);
				expect(message).toBeTruthy();
			});
		});
	});

	describe('Executing state', () => {
		beforeEach(() => {
			vi.mocked(getCheckpoints).mockResolvedValue({ checkpoints: createMockCheckpoints(1) });
			vi.mocked(previewRewind).mockResolvedValue({
				preview: createMockPreview(),
			});
			vi.mocked(executeRewind).mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() =>
								resolve({
									result: { success: true, filesChanged: [] },
								}),
							1000
						)
					)
			);
		});

		it('should show executing state while rewinding', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			// Click rewind button
			await waitFor(() => {
				const rewindButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Rewind'
				);
				rewindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			// Should show "Rewinding..." text
			await waitFor(() => {
				const executingButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Rewinding...'
				);
				expect(executingButton).toBeTruthy();
			});
		});

		it('should disable buttons while executing', async () => {
			render(<RewindModal isOpen={true} onClose={() => {}} sessionId="test-session" />);

			// Click rewind button
			await waitFor(() => {
				const rewindButton = Array.from(document.body.querySelectorAll('button')).find(
					(btn) => btn.textContent === 'Rewind'
				);
				rewindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});

			// Check that buttons are disabled
			await waitFor(() => {
				const buttons = document.body.querySelectorAll('button[disabled]');
				expect(buttons.length).toBeGreaterThan(0);
			});
		});
	});
});
