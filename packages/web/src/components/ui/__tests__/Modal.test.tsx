// @ts-nocheck
/**
 * Tests for Modal Component
 */

import { render, cleanup } from '@testing-library/preact';
import { describe, it, expect, mock, spyOn, vi } from 'vitest';
import { Modal } from '../Modal';

describe('Modal', () => {
	beforeEach(() => {
		// Clean up any existing portals
		document.body.innerHTML = '';
	});

	afterEach(() => {
		cleanup();
		document.body.style.overflow = '';
	});

	describe('Rendering', () => {
		it('should render children when open', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Modal Content</p>
				</Modal>
			);
			const content = document.body.querySelector('p');
			expect(content?.textContent).toBe('Modal Content');
		});

		it('should not render when closed', () => {
			const onClose = mock(() => {});
			const { container } = render(
				<Modal isOpen={false} onClose={onClose}>
					<p>Modal Content</p>
				</Modal>
			);
			const content = document.body.querySelector('p');
			expect(content).toBeNull();
			expect(container.innerHTML).toBe('');
		});

		it('should render title when provided', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose} title="Test Title">
					<p>Content</p>
				</Modal>
			);
			const title = document.body.querySelector('h2');
			expect(title?.textContent).toBe('Test Title');
		});

		it('should render close button by default', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose} title="Test">
					<p>Content</p>
				</Modal>
			);
			const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
			expect(closeButton).toBeTruthy();
		});

		it('should not render close button when showCloseButton is false', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose} showCloseButton={false}>
					<p>Content</p>
				</Modal>
			);
			const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
			expect(closeButton).toBeNull();
		});

		it('should not render header when no title and no close button', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose} showCloseButton={false}>
					<p>Content</p>
				</Modal>
			);
			// Header is only rendered when title or showCloseButton is present
			const header = document.body.querySelector('.border-b');
			expect(header).toBeNull();
		});
	});

	describe('Sizes', () => {
		it('should render medium size by default', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);
			const modal = document.body.querySelector('.bg-dark-900');
			expect(modal?.className).toContain('max-w-lg');
		});

		it('should render small size', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose} size="sm">
					<p>Content</p>
				</Modal>
			);
			const modal = document.body.querySelector('.bg-dark-900');
			expect(modal?.className).toContain('max-w-md');
		});

		it('should render large size', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose} size="lg">
					<p>Content</p>
				</Modal>
			);
			const modal = document.body.querySelector('.bg-dark-900');
			expect(modal?.className).toContain('max-w-2xl');
		});

		it('should render extra large size', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose} size="xl">
					<p>Content</p>
				</Modal>
			);
			const modal = document.body.querySelector('.bg-dark-900');
			expect(modal?.className).toContain('max-w-4xl');
		});
	});

	describe('Interactions', () => {
		it('should call onClose when Escape key is pressed', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);

			const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
			document.dispatchEvent(escapeEvent);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should not call onClose for other keys', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);

			const enterEvent = new KeyboardEvent('keydown', { key: 'Enter' });
			document.dispatchEvent(enterEvent);

			expect(onClose).not.toHaveBeenCalled();
		});

		it('should call onClose when backdrop is clicked', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);

			const backdrop = document.body.querySelector('.bg-black\\/70');
			backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should not call onClose when modal content is clicked', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p data-testid="content">Content</p>
				</Modal>
			);

			const modalContent = document.body.querySelector('.bg-dark-900');
			modalContent?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			expect(onClose).not.toHaveBeenCalled();
		});

		it('should call onClose when close button is clicked', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose} title="Test">
					<p>Content</p>
				</Modal>
			);

			const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
			closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should set body overflow to hidden when open', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);

			expect(document.body.style.overflow).toBe('hidden');
		});
	});

	describe('Accessibility', () => {
		it('should have close button with aria-label', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose} title="Test">
					<p>Content</p>
				</Modal>
			);
			const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
			expect(closeButton).toBeTruthy();
		});

		it('should render in a portal', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);
			// Check that content is rendered in body (via portal)
			const portalContainer = document.body.querySelector('[data-portal="true"]');
			expect(portalContainer).toBeTruthy();
		});

		it('should have proper z-index for stacking', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);
			const modalOverlay = document.body.querySelector('.z-50');
			expect(modalOverlay).toBeTruthy();
		});

		it('should have role-based focus trap elements', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose} title="Test">
					<button>First Button</button>
					<input type="text" placeholder="Input" />
					<button>Last Button</button>
				</Modal>
			);
			// Modal should contain focusable elements
			const modal = document.body.querySelector('.bg-dark-900');
			const buttons = modal?.querySelectorAll('button');
			const inputs = modal?.querySelectorAll('input');
			expect(buttons?.length).toBeGreaterThan(0);
			expect(inputs?.length).toBe(1);
		});
	});

	describe('Animations', () => {
		it('should have fadeIn animation class', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);
			const modalOverlay = document.body.querySelector('.animate-fadeIn');
			expect(modalOverlay).toBeTruthy();
		});

		it('should have scaleIn animation class on modal', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);
			const modal = document.body.querySelector('.animate-scaleIn');
			expect(modal).toBeTruthy();
		});
	});

	describe('Styling', () => {
		it('should have rounded corners', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);
			const modal = document.body.querySelector('.rounded-xl');
			expect(modal).toBeTruthy();
		});

		it('should have shadow', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);
			const modal = document.body.querySelector('.shadow-2xl');
			expect(modal).toBeTruthy();
		});

		it('should have backdrop blur on overlay', () => {
			const onClose = mock(() => {});
			render(
				<Modal isOpen={true} onClose={onClose}>
					<p>Content</p>
				</Modal>
			);
			const backdrop = document.body.querySelector('.backdrop-blur-sm');
			expect(backdrop).toBeTruthy();
		});
	});
});
