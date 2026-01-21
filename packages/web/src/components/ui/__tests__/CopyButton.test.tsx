// @ts-nocheck
/**
 * Tests for CopyButton Component
 */

import { render, cleanup, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopyButton } from '../CopyButton';

// Mock copyToClipboard
vi.mock('../../../lib/utils.ts', () => ({
	copyToClipboard: vi.fn(),
}));

// Mock toast
vi.mock('../../../lib/toast.ts', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

import { copyToClipboard } from '../../../lib/utils.ts';
import { toast } from '../../../lib/toast.ts';

describe('CopyButton', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Rendering', () => {
		it('should render a button', () => {
			render(<CopyButton text="test text" />);
			const button = document.body.querySelector('button');
			expect(button).toBeTruthy();
		});

		it('should render clipboard icon by default', () => {
			render(<CopyButton text="test text" />);
			const svg = document.body.querySelector('svg');
			expect(svg).toBeTruthy();
			expect(svg?.classList.contains('w-4')).toBe(true);
			expect(svg?.classList.contains('h-4')).toBe(true);
		});

		it('should have correct title from label prop', () => {
			render(<CopyButton text="test text" label="Copy session ID" />);
			const button = document.body.querySelector('button');
			expect(button?.getAttribute('title')).toBe('Copy session ID');
		});

		it('should use default label when not provided', () => {
			render(<CopyButton text="test text" />);
			const button = document.body.querySelector('button');
			expect(button?.getAttribute('title')).toBe('Copy to clipboard');
		});
	});

	describe('Copy Functionality', () => {
		it('should call copyToClipboard when clicked', async () => {
			(copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			render(<CopyButton text="test text" />);
			const button = document.body.querySelector('button');
			button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			await waitFor(() => {
				expect(copyToClipboard).toHaveBeenCalledWith('test text');
			});
		});

		it('should show success toast on successful copy', async () => {
			(copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			render(<CopyButton text="test text" />);
			const button = document.body.querySelector('button');
			button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			await waitFor(() => {
				expect(toast.success).toHaveBeenCalledWith('Copied to clipboard');
			});
		});

		it('should show custom success message', async () => {
			(copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			render(<CopyButton text="test text" successMessage="SDK ID copied!" />);
			const button = document.body.querySelector('button');
			button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			await waitFor(() => {
				expect(toast.success).toHaveBeenCalledWith('SDK ID copied!');
			});
		});

		it('should show error toast on failed copy', async () => {
			(copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(false);

			render(<CopyButton text="test text" />);
			const button = document.body.querySelector('button');
			button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			await waitFor(() => {
				expect(toast.error).toHaveBeenCalledWith('Failed to copy');
			});
		});

		it('should show checkmark icon after successful copy', async () => {
			(copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			render(<CopyButton text="test text" />);
			const button = document.body.querySelector('button');
			button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			await waitFor(() => {
				const svg = document.body.querySelector('svg');
				// Check for green color class indicating checkmark
				expect(svg?.classList.contains('text-green-400')).toBe(true);
			});
		});
	});

	describe('Styling', () => {
		it('should have proper button styling', () => {
			render(<CopyButton text="test text" />);
			const button = document.body.querySelector('button');
			expect(button?.className).toContain('p-1.5');
			expect(button?.className).toContain('text-gray-400');
			expect(button?.className).toContain('hover:text-gray-200');
			expect(button?.className).toContain('rounded');
		});

		it('should have button type attribute', () => {
			render(<CopyButton text="test text" />);
			const button = document.body.querySelector('button');
			expect(button?.getAttribute('type')).toBe('button');
		});
	});
});
