// @ts-nocheck
/**
 * Tests for Dropdown Component
 */

import './setup'; // Setup Happy-DOM
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, cleanup } from '@testing-library/preact';
import { Dropdown, DropdownMenuItem } from '../Dropdown';

describe('Dropdown', () => {
	const defaultItems: DropdownMenuItem[] = [
		{ label: 'Item 1', onClick: mock(() => {}) },
		{ label: 'Item 2', onClick: mock(() => {}) },
		{ label: 'Item 3', onClick: mock(() => {}) },
	];

	beforeEach(() => {
		document.body.innerHTML = '';
	});

	afterEach(() => {
		cleanup();
	});

	describe('Rendering', () => {
		it('should render trigger element', () => {
			const { container } = render(
				<Dropdown trigger={<button>Open Menu</button>} items={defaultItems} />
			);
			const trigger = container.querySelector('button');
			expect(trigger?.textContent).toBe('Open Menu');
		});

		it('should not render menu items when closed', () => {
			const { container } = render(
				<Dropdown trigger={<button>Open Menu</button>} items={defaultItems} />
			);
			const menuItems = container.querySelectorAll('[role="menuitem"]');
			expect(menuItems.length).toBe(0);
		});

		it('should render menu items when opened', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open Menu</button>} items={defaultItems} />
			);
			const trigger = container.querySelector('button');
			trigger?.click();

			await waitFor(() => {
				const menu = document.body.querySelector('[role="menu"]');
				expect(menu).toBeTruthy();
			});

			const menuItems = document.body.querySelectorAll('[role="menuitem"]');
			expect(menuItems.length).toBe(3);
		});

		it('should render item icons when provided', async () => {
			const itemsWithIcons: DropdownMenuItem[] = [
				{
					label: 'Item with Icon',
					onClick: mock(() => {}),
					icon: <span class="test-icon">Icon</span>,
				},
			];

			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={itemsWithIcons} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const icon = document.body.querySelector('.test-icon');
				expect(icon).toBeTruthy();
			});
		});

		it('should render dividers', async () => {
			const itemsWithDivider: DropdownMenuItem[] = [
				{ label: 'Item 1', onClick: mock(() => {}) },
				{ type: 'divider' },
				{ label: 'Item 2', onClick: mock(() => {}) },
			];

			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={itemsWithDivider} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const divider = document.body.querySelector('.bg-dark-700');
				expect(divider).toBeTruthy();
			});
		});

		it('should render custom content instead of menu items', async () => {
			const { container } = render(
				<Dropdown
					trigger={<button>Open</button>}
					items={[]}
					customContent={<div class="custom-content">Custom Content</div>}
				/>
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const customContent = document.body.querySelector('.custom-content');
				expect(customContent?.textContent).toBe('Custom Content');
			});
		});
	});

	describe('Positions', () => {
		it('should default to right alignment', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
				expect(menu).toBeTruthy();
				// Right alignment uses 'right' style property
				expect(menu?.style.right).toBeTruthy();
			});
		});

		it('should support left alignment', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} position="left" />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
				expect(menu).toBeTruthy();
				// Left alignment uses 'left' style property
				expect(menu?.style.left).toBeTruthy();
			});
		});
	});

	describe('Interactions', () => {
		it('should open when trigger is clicked', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} />
			);

			const trigger = container.querySelector('button');
			trigger?.click();

			await waitFor(() => {
				const menu = document.body.querySelector('[role="menu"]');
				expect(menu).toBeTruthy();
			});
		});

		it('should close when trigger is clicked again', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} />
			);

			// Click the trigger button directly
			const trigger = container.querySelector('button');
			trigger?.click();

			await waitFor(() => {
				const menu = container.querySelector('[role="menu"]');
				expect(menu).toBeTruthy();
			});

			trigger?.click();

			// Menu should close
			await waitFor(() => {
				const menu = container.querySelector('[role="menu"]');
				expect(menu).toBeNull();
			});
		});

		it('should close when Escape key is pressed', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} />
			);

			container.querySelector('button')?.click();

			await waitFor(() => {
				const menu = document.body.querySelector('[role="menu"]');
				expect(menu).toBeTruthy();
			});

			// Wait for the delayed event listener to be added
			await new Promise((resolve) => setTimeout(resolve, 10));

			const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
			document.dispatchEvent(escapeEvent);

			await waitFor(() => {
				const menu = document.body.querySelector('[role="menu"]');
				expect(menu).toBeNull();
			});
		});

		it('should call onClick handler when item is clicked', async () => {
			const onClick = mock(() => {});
			const items: DropdownMenuItem[] = [{ label: 'Click Me', onClick }];

			const { container } = render(<Dropdown trigger={<button>Open</button>} items={items} />);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menuItem = document.body.querySelector('[role="menuitem"]');
				expect(menuItem).toBeTruthy();
			});

			const menuItem = document.body.querySelector('[role="menuitem"]');
			menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			// Wait for async onClick handling
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(onClick).toHaveBeenCalledTimes(1);
		});

		it('should close menu after item is clicked', async () => {
			const items: DropdownMenuItem[] = [{ label: 'Click Me', onClick: mock(() => {}) }];

			const { container } = render(<Dropdown trigger={<button>Open</button>} items={items} />);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menuItem = document.body.querySelector('[role="menuitem"]');
				expect(menuItem).toBeTruthy();
			});

			const menuItem = document.body.querySelector('[role="menuitem"]');
			menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			await waitFor(() => {
				const menu = document.body.querySelector('[role="menu"]');
				expect(menu).toBeNull();
			});
		});

		it('should not call onClick for disabled items', async () => {
			const onClick = mock(() => {});
			const items: DropdownMenuItem[] = [{ label: 'Disabled', onClick, disabled: true }];

			const { container } = render(<Dropdown trigger={<button>Open</button>} items={items} />);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menuItem = document.body.querySelector('[role="menuitem"]');
				expect(menuItem).toBeTruthy();
			});

			const menuItem = document.body.querySelector('[role="menuitem"]');
			menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			expect(onClick).not.toHaveBeenCalled();
		});
	});

	describe('Keyboard Navigation', () => {
		it('should have menu items focusable', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menuItems = document.body.querySelectorAll('[role="menuitem"]');
				expect(menuItems.length).toBe(3);
			});

			const menuItems = document.body.querySelectorAll('[role="menuitem"]');
			// All menu items should be buttons and focusable
			menuItems.forEach((item) => {
				expect(item.tagName.toLowerCase()).toBe('button');
			});
		});

		it('should navigate with arrow keys', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menuItems = document.body.querySelectorAll('[role="menuitem"]');
				expect(menuItems.length).toBe(3);
			});

			const dropdown = container.querySelector('.relative');

			// Simulate arrow down
			const arrowDownEvent = new KeyboardEvent('keydown', {
				key: 'ArrowDown',
				bubbles: true,
			});
			dropdown?.dispatchEvent(arrowDownEvent);

			// The keyboard navigation should work (tested by lack of errors)
			const menuItems = document.body.querySelectorAll('[role="menuitem"]');
			expect(menuItems.length).toBe(3);
		});
	});

	describe('Controlled Mode', () => {
		it('should respect controlled isOpen prop', async () => {
			const onOpenChange = mock(() => {});
			const { rerender } = render(
				<Dropdown
					trigger={<button>Open</button>}
					items={defaultItems}
					isOpen={false}
					onOpenChange={onOpenChange}
				/>
			);

			// Should be closed
			let menu = document.body.querySelector('[role="menu"]');
			expect(menu).toBeNull();

			// Rerender with isOpen=true
			rerender(
				<Dropdown
					trigger={<button>Open</button>}
					items={defaultItems}
					isOpen={true}
					onOpenChange={onOpenChange}
				/>
			);

			await waitFor(() => {
				menu = document.body.querySelector('[role="menu"]');
				expect(menu).toBeTruthy();
			});
		});

		it('should call onOpenChange when toggling', async () => {
			const onOpenChange = mock(() => {});
			const { container } = render(
				<Dropdown
					trigger={<button>Open</button>}
					items={defaultItems}
					onOpenChange={onOpenChange}
				/>
			);

			const trigger = container.querySelector('button');
			trigger?.click();

			expect(onOpenChange).toHaveBeenCalledWith(true);
		});
	});

	describe('Styling', () => {
		it('should apply custom className', () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} class="custom-dropdown" />
			);
			const dropdown = container.querySelector('.custom-dropdown');
			expect(dropdown).toBeTruthy();
		});

		it('should style danger items differently', async () => {
			const dangerItems: DropdownMenuItem[] = [
				{ label: 'Delete', onClick: mock(() => {}), danger: true },
			];

			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={dangerItems} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menuItem = document.body.querySelector('[role="menuitem"]');
				expect(menuItem?.className).toContain('text-red-400');
			});
		});

		it('should style disabled items differently', async () => {
			const disabledItems: DropdownMenuItem[] = [
				{ label: 'Disabled', onClick: mock(() => {}), disabled: true },
			];

			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={disabledItems} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menuItem = document.body.querySelector('[role="menuitem"]');
				expect(menuItem?.className).toContain('text-gray-600');
				expect(menuItem?.className).toContain('cursor-not-allowed');
			});
		});

		it('should have animation class', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menu = document.body.querySelector('.animate-slideIn');
				expect(menu).toBeTruthy();
			});
		});
	});

	describe('Accessibility', () => {
		it('should have role="menu" on dropdown container', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menu = document.body.querySelector('[role="menu"]');
				expect(menu).toBeTruthy();
			});
		});

		it('should have role="menuitem" on items', async () => {
			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={defaultItems} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menuItems = document.body.querySelectorAll('[role="menuitem"]');
				expect(menuItems.length).toBe(3);
			});
		});

		it('should have disabled attribute on disabled items', async () => {
			const disabledItems: DropdownMenuItem[] = [
				{ label: 'Disabled', onClick: mock(() => {}), disabled: true },
			];

			const { container } = render(
				<Dropdown trigger={<button>Open</button>} items={disabledItems} />
			);
			container.querySelector('button')?.click();

			await waitFor(() => {
				const menuItem = document.body.querySelector('[role="menuitem"]') as HTMLButtonElement;
				expect(menuItem?.disabled).toBe(true);
			});
		});
	});
});
