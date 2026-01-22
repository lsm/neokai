// @ts-nocheck
/**
 * Tests for SessionInfoModal Component
 */

import { render, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionInfoModal } from '../SessionInfoModal';
import type { Session } from '@liuboer/shared';

// Mock CopyButton to simplify testing
vi.mock('../ui/CopyButton', () => ({
	CopyButton: ({ text, label }: { text: string; label?: string }) => (
		<button data-testid="copy-button" data-text={text} title={label}>
			Copy
		</button>
	),
}));

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'test-session-id',
		title: 'Test Session',
		workspacePath: '/Users/test/project',
		createdAt: '2024-01-01T00:00:00.000Z',
		lastActiveAt: '2024-01-01T00:00:00.000Z',
		status: 'active',
		config: {
			model: 'claude-sonnet-4-5-20250929',
			maxTokens: 8192,
			temperature: 1.0,
		},
		metadata: {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		},
		...overrides,
	};
}

describe('SessionInfoModal', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	afterEach(() => {
		cleanup();
		document.body.style.overflow = '';
	});

	describe('Rendering', () => {
		it('should render modal with title', () => {
			const session = createMockSession();
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

			const title = document.body.querySelector('h2');
			expect(title?.textContent).toBe('Session Info');
		});

		it('should not render when closed', () => {
			const session = createMockSession();
			render(<SessionInfoModal isOpen={false} onClose={() => {}} session={session} />);

			const modal = document.body.querySelector('[role="dialog"]');
			expect(modal).toBeNull();
		});

		it('should not render when session is null', () => {
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={null} />);

			const modal = document.body.querySelector('[role="dialog"]');
			expect(modal).toBeNull();
		});
	});

	describe('SDK Folder Path', () => {
		it('should display SDK folder path', () => {
			const session = createMockSession({ workspacePath: '/Users/test/project' });
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

			// Find the SDK Folder label
			const labels = document.body.querySelectorAll('span');
			const sdkFolderLabel = Array.from(labels).find((l) => l.textContent === 'SDK Folder');
			expect(sdkFolderLabel).toBeTruthy();
		});

		it('should compute SDK folder path correctly', () => {
			const session = createMockSession({ workspacePath: '/Users/test/project' });
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

			// The path should replace / and . with -
			// /Users/test/project -> -Users-test-project
			const expectedPath = '~/.claude/projects/-Users-test-project';

			// Find the copy button with the SDK folder path
			const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
			const sdkFolderButton = Array.from(copyButtons).find(
				(btn) => btn.getAttribute('data-text') === expectedPath
			);
			expect(sdkFolderButton).toBeTruthy();
		});

		it('should handle workspace path with dots', () => {
			const session = createMockSession({ workspacePath: '/Users/test/.config/project' });
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

			// Both / and . should be replaced with -
			const expectedPath = '~/.claude/projects/-Users-test--config-project';

			const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
			const sdkFolderButton = Array.from(copyButtons).find(
				(btn) => btn.getAttribute('data-text') === expectedPath
			);
			expect(sdkFolderButton).toBeTruthy();
		});
	});

	describe('SDK Session ID', () => {
		it('should display SDK session ID when available', () => {
			const session = createMockSession({ sdkSessionId: 'sdk-123-456' });
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

			// Find the SDK Session ID label
			const labels = document.body.querySelectorAll('span');
			const sdkSessionLabel = Array.from(labels).find((l) => l.textContent === 'SDK Session ID');
			expect(sdkSessionLabel).toBeTruthy();

			// Find the copy button with the SDK session ID
			const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
			const sdkSessionButton = Array.from(copyButtons).find(
				(btn) => btn.getAttribute('data-text') === 'sdk-123-456'
			);
			expect(sdkSessionButton).toBeTruthy();
		});

		it('should not display SDK session ID when not available', () => {
			const session = createMockSession({ sdkSessionId: undefined });
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

			// Find the SDK Session ID label - should not exist
			const labels = document.body.querySelectorAll('span');
			const sdkSessionLabel = Array.from(labels).find((l) => l.textContent === 'SDK Session ID');
			expect(sdkSessionLabel).toBeFalsy();
		});
	});

	describe('Copy Buttons', () => {
		it('should render copy button for SDK folder', () => {
			const session = createMockSession();
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

			const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
			expect(copyButtons.length).toBeGreaterThanOrEqual(1);
		});

		it('should render copy button for SDK session ID when available', () => {
			const session = createMockSession({ sdkSessionId: 'sdk-123' });
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

			const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
			// Now displays many fields, so there should be multiple copy buttons
			expect(copyButtons.length).toBeGreaterThan(2);
		});
	});

	describe('Interactions', () => {
		it('should call onClose when close button is clicked', () => {
			const onClose = vi.fn();
			const session = createMockSession();
			render(<SessionInfoModal isOpen={true} onClose={onClose} session={session} />);

			const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
			closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should call onClose when Escape is pressed', () => {
			const onClose = vi.fn();
			const session = createMockSession();
			render(<SessionInfoModal isOpen={true} onClose={onClose} session={session} />);

			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Styling', () => {
		it('should use large size modal', () => {
			const session = createMockSession();
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

			const modal = document.body.querySelector('.bg-dark-900');
			expect(modal?.className).toContain('max-w-2xl');
		});

		it('should render in portal', () => {
			const session = createMockSession();
			render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

			const portal = document.body.querySelector('[data-portal="true"]');
			expect(portal).toBeTruthy();
		});
	});
});
