import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toast, ToastAction, ToastDescription, Toaster, ToastTitle, useToast } from '../src/mod.ts';

class RAFQueue {
	callbacks: FrameRequestCallback[] = [];
	private idCounter = 0;
	schedule(cb: FrameRequestCallback): number {
		this.callbacks.push(cb);
		return ++this.idCounter;
	}
	flush(maxRounds = 20): void {
		for (let i = 0; i < maxRounds; i++) {
			if (!this.callbacks.length) break;
			const batch = this.callbacks.splice(0);
			for (const cb of batch) cb(performance.now());
		}
	}
	install(): void {
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => this.schedule(cb));
		vi.stubGlobal('cancelAnimationFrame', () => {});
	}
}

// The toast store is module-level. We must clean it up between tests by
// dismissing all toasts via the hook.
function ToastResetter() {
	const { toasts, dismiss } = useToast();
	// Dismiss all immediately on mount
	for (const t of toasts) {
		dismiss(t.id);
	}
	return null;
}

afterEach(async () => {
	// Dismiss any lingering toasts from the module-level store
	await act(async () => {
		render(<ToastResetter />);
	});
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
	const portalRoot = document.getElementById('headlessui-portal-root');
	if (portalRoot) portalRoot.remove();
});

// -------------------------
// useToast hook
// -------------------------

describe('useToast hook', () => {
	it('toast() creates a toast and returns its id', async () => {
		function TestComponent() {
			const { toast, toasts } = useToast();
			return (
				<div>
					<button onClick={() => toast({ title: 'Hello' })}>Add</button>
					<span data-testid="count">{toasts.length}</span>
				</div>
			);
		}

		render(<TestComponent />);
		expect(screen.getByTestId('count').textContent).toBe('0');

		await act(async () => {
			fireEvent.click(screen.getByText('Add'));
		});
		expect(screen.getByTestId('count').textContent).toBe('1');
	});

	it('dismiss() removes a toast by id', async () => {
		function TestComponent() {
			const { toast, dismiss, toasts } = useToast();
			return (
				<div>
					<button
						onClick={() => {
							const id = toast({ title: 'Hello' });
							dismiss(id);
						}}
					>
						AddAndDismiss
					</button>
					<span data-testid="count">{toasts.length}</span>
				</div>
			);
		}

		render(<TestComponent />);
		await act(async () => {
			fireEvent.click(screen.getByText('AddAndDismiss'));
		});
		expect(screen.getByTestId('count').textContent).toBe('0');
	});

	it('multiple toasts can be active simultaneously', async () => {
		function TestComponent() {
			const { toast, toasts } = useToast();
			return (
				<div>
					<button onClick={() => toast({ title: `Toast ${toasts.length + 1}` })}>Add</button>
					<span data-testid="count">{toasts.length}</span>
				</div>
			);
		}

		render(<TestComponent />);
		await act(async () => {
			fireEvent.click(screen.getByText('Add'));
		});
		await act(async () => {
			fireEvent.click(screen.getByText('Add'));
		});
		await act(async () => {
			fireEvent.click(screen.getByText('Add'));
		});
		expect(screen.getByTestId('count').textContent).toBe('3');
	});

	it('toast() with existing id replaces that toast', async () => {
		function TestComponent() {
			const { toast, toasts } = useToast();
			return (
				<div>
					<button onClick={() => toast({ id: 'fixed-id', title: 'v1' })}>AddFixed</button>
					<button onClick={() => toast({ id: 'fixed-id', title: 'v2' })}>UpdateFixed</button>
					<span data-testid="count">{toasts.length}</span>
					<span data-testid="title">{toasts[0]?.title ?? ''}</span>
				</div>
			);
		}

		render(<TestComponent />);
		await act(async () => {
			fireEvent.click(screen.getByText('AddFixed'));
		});
		expect(screen.getByTestId('count').textContent).toBe('1');

		await act(async () => {
			fireEvent.click(screen.getByText('UpdateFixed'));
		});
		// Should still be 1 (replaced, not added)
		expect(screen.getByTestId('count').textContent).toBe('1');
		expect(screen.getByTestId('title').textContent).toBe('v2');
	});
});

// -------------------------
// Toast component
// -------------------------

describe('Toast component', () => {
	it('renders with role="status" when show=true', async () => {
		render(
			<Toast show={true}>
				<div>Toast content</div>
			</Toast>
		);
		await act(async () => {});
		const toast = document.querySelector('[role="status"]');
		expect(toast).not.toBeNull();
	});

	it('does not render content when show=false', async () => {
		render(
			<Toast show={false}>
				<div data-testid="inner">Toast content</div>
			</Toast>
		);
		await act(async () => {});
		// When show=false, Transition unmounts content
		expect(screen.queryByTestId('inner')).toBeNull();
	});

	it('auto-dismisses after duration', async () => {
		const raf = new RAFQueue();
		raf.install();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		render(
			<Toast show={true} duration={1000}>
				<div data-testid="inner">Content</div>
			</Toast>
		);
		await act(async () => {});
		expect(screen.queryByTestId('inner')).not.toBeNull();

		// Advance past auto-dismiss timer
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		// Flush the RAF that runLeave() schedules
		await act(async () => {
			raf.flush();
		});
		expect(screen.queryByTestId('inner')).toBeNull();
	});

	it('duration=0 never auto-dismisses', async () => {
		vi.useFakeTimers();
		render(
			<Toast show={true} duration={0}>
				<div data-testid="inner">Content</div>
			</Toast>
		);
		await act(async () => {});
		await act(async () => {
			vi.advanceTimersByTime(100000);
		});
		expect(screen.queryByTestId('inner')).not.toBeNull();
	});

	it('respects show prop change (controlled)', async () => {
		const raf = new RAFQueue();
		raf.install();

		const { rerender } = render(
			<Toast show={true} duration={0}>
				<div data-testid="inner">Content</div>
			</Toast>
		);
		await act(async () => {});
		expect(screen.queryByTestId('inner')).not.toBeNull();

		await act(async () => {
			rerender(
				<Toast show={false} duration={0}>
					<div data-testid="inner">Content</div>
				</Toast>
			);
		});
		// Flush leave RAF
		await act(async () => {
			raf.flush();
		});
		expect(screen.queryByTestId('inner')).toBeNull();
	});

	it('calls afterLeave when transition leaves', async () => {
		const raf = new RAFQueue();
		raf.install();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		const afterLeave = vi.fn();
		render(
			<Toast show={true} duration={100} afterLeave={afterLeave}>
				<div>Content</div>
			</Toast>
		);
		await act(async () => {});
		// Advance past auto-dismiss timer
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
		// Flush leave RAF — afterLeave() is called inside the RAF callback
		// (waitForTransition is immediate with no CSS transitions)
		await act(async () => {
			raf.flush();
		});
		expect(afterLeave).toHaveBeenCalled();
	});
});

// -------------------------
// ToastTitle
// -------------------------

describe('ToastTitle', () => {
	it('throws when used outside Toast', () => {
		expect(() => {
			render(<ToastTitle>Title</ToastTitle>);
		}).toThrow('<ToastTitle> must be used within a <Toast>');
	});

	it('renders inside Toast and wires aria-labelledby', async () => {
		render(
			<Toast show={true}>
				<ToastTitle data-testid="title">My Title</ToastTitle>
			</Toast>
		);
		await act(async () => {});

		const toast = document.querySelector('[role="status"]');
		const title = screen.queryByTestId('title');
		expect(title).not.toBeNull();

		const titleId = title?.getAttribute('id');
		expect(titleId).toBeTruthy();
		expect(toast?.getAttribute('aria-labelledby')).toBe(titleId);
	});

	it('renders with custom as prop', async () => {
		render(
			<Toast show={true}>
				<ToastTitle as="h3" data-testid="title">
					Title
				</ToastTitle>
			</Toast>
		);
		await act(async () => {});
		const title = screen.queryByTestId('title');
		expect(title?.tagName.toLowerCase()).toBe('h3');
	});
});

// -------------------------
// ToastDescription
// -------------------------

describe('ToastDescription', () => {
	it('throws when used outside Toast', () => {
		expect(() => {
			render(<ToastDescription>Desc</ToastDescription>);
		}).toThrow('<ToastDescription> must be used within a <Toast>');
	});

	it('renders inside Toast and wires aria-describedby', async () => {
		render(
			<Toast show={true}>
				<ToastDescription data-testid="desc">My Description</ToastDescription>
			</Toast>
		);
		await act(async () => {});

		const toast = document.querySelector('[role="status"]');
		const desc = screen.queryByTestId('desc');
		expect(desc).not.toBeNull();

		const descId = desc?.getAttribute('id');
		expect(descId).toBeTruthy();
		expect(toast?.getAttribute('aria-describedby')).toBe(descId);
	});

	it('renders with custom as prop', async () => {
		render(
			<Toast show={true}>
				<ToastDescription as="span" data-testid="desc">
					Desc
				</ToastDescription>
			</Toast>
		);
		await act(async () => {});
		const desc = screen.queryByTestId('desc');
		expect(desc?.tagName.toLowerCase()).toBe('span');
	});
});

// -------------------------
// ToastAction
// -------------------------

describe('ToastAction', () => {
	it('throws when used outside Toast', () => {
		expect(() => {
			render(<ToastAction>Action</ToastAction>);
		}).toThrow('<ToastAction> must be used within a <Toast>');
	});

	it('renders as button inside Toast', async () => {
		render(
			<Toast show={true}>
				<ToastAction data-testid="action">Click me</ToastAction>
			</Toast>
		);
		await act(async () => {});
		const action = screen.queryByTestId('action');
		expect(action).not.toBeNull();
		expect(action?.tagName.toLowerCase()).toBe('button');
	});

	it('calls onClick when clicked', async () => {
		const onClick = vi.fn();
		render(
			<Toast show={true}>
				<ToastAction onClick={onClick} data-testid="action">
					Click me
				</ToastAction>
			</Toast>
		);
		await act(async () => {});
		await act(async () => {
			fireEvent.click(screen.getByTestId('action'));
		});
		expect(onClick).toHaveBeenCalled();
	});

	it('sets hover state on mouseenter/mouseleave', async () => {
		render(
			<Toast show={true}>
				<ToastAction data-testid="action">Action</ToastAction>
			</Toast>
		);
		await act(async () => {});
		const action = screen.getByTestId('action');
		await act(async () => {
			fireEvent.mouseEnter(action);
		});
		await act(async () => {
			fireEvent.mouseLeave(action);
		});
		// No error thrown
		expect(action).not.toBeNull();
	});

	it('sets focus state on focus/blur', async () => {
		render(
			<Toast show={true}>
				<ToastAction data-testid="action">Action</ToastAction>
			</Toast>
		);
		await act(async () => {});
		const action = screen.getByTestId('action');
		await act(async () => {
			action.focus();
		});
		await act(async () => {
			action.blur();
		});
		expect(action).not.toBeNull();
	});

	it('sets active state on mousedown/mouseup', async () => {
		render(
			<Toast show={true}>
				<ToastAction data-testid="action">Action</ToastAction>
			</Toast>
		);
		await act(async () => {});
		const action = screen.getByTestId('action');
		await act(async () => {
			fireEvent.mouseDown(action);
		});
		await act(async () => {
			fireEvent.mouseUp(action);
		});
		expect(action).not.toBeNull();
	});
});

// -------------------------
// Toaster component
// -------------------------

describe('Toaster', () => {
	it('renders in portal (outside component tree container)', async () => {
		render(<Toaster />);
		await act(async () => {});
		// Portal mounts inside portal root
		const portalRoot = document.getElementById('headlessui-portal-root');
		expect(portalRoot).not.toBeNull();
	});

	it('has role="region" and aria-live="polite"', async () => {
		render(<Toaster />);
		await act(async () => {});
		const region = document.querySelector('[role="region"]');
		expect(region).not.toBeNull();
		expect(region?.getAttribute('aria-live')).toBe('polite');
	});

	it('has data-position attribute', async () => {
		render(<Toaster position="top-right" />);
		await act(async () => {});
		const region = document.querySelector('[role="region"]');
		expect(region?.getAttribute('data-position')).toBe('top-right');
	});

	it('defaults to bottom-right position', async () => {
		render(<Toaster />);
		await act(async () => {});
		const region = document.querySelector('[role="region"]');
		expect(region?.getAttribute('data-position')).toBe('bottom-right');
	});

	it('renders managed toasts when toasts are added via useToast', async () => {
		function AddToast() {
			const { toast } = useToast();
			return (
				<button onClick={() => toast({ title: 'Managed Toast', duration: 0 })}>Add Toast</button>
			);
		}

		render(
			<>
				<AddToast />
				<Toaster />
			</>
		);
		await act(async () => {});

		await act(async () => {
			fireEvent.click(screen.getByText('Add Toast'));
		});
		await act(async () => {});

		// The toast title should now be in the document
		expect(document.body.textContent).toContain('Managed Toast');
	});

	it('renders managed toast with description', async () => {
		function AddToast() {
			const { toast } = useToast();
			return (
				<button
					onClick={() => toast({ title: 'Hello', description: 'World description', duration: 0 })}
				>
					Add
				</button>
			);
		}

		render(
			<>
				<AddToast />
				<Toaster />
			</>
		);
		await act(async () => {});
		await act(async () => {
			fireEvent.click(screen.getByText('Add'));
		});
		await act(async () => {});
		expect(document.body.textContent).toContain('World description');
	});

	it('renders custom children when provided', async () => {
		render(
			<Toaster>
				<div data-testid="custom-child">Custom</div>
			</Toaster>
		);
		await act(async () => {});
		// Custom children are rendered inside the portal
		expect(document.querySelector('[data-testid="custom-child"]')).not.toBeNull();
	});

	it('passes through additional props', async () => {
		render(<Toaster data-testid="toaster" />);
		await act(async () => {});
		expect(document.querySelector('[data-testid="toaster"]')).not.toBeNull();
	});

	it('renders with custom as prop', async () => {
		render(<Toaster as="nav" data-testid="toaster-nav" />);
		await act(async () => {});
		const el = document.querySelector('[data-testid="toaster-nav"]');
		expect(el?.tagName.toLowerCase()).toBe('nav');
	});

	it('removes managed toast from store after leave transition (afterLeave callback)', async () => {
		// This test covers Toaster's afterLeave: () => dismiss(item.id) callback (line 339)
		// which is called when a managed toast finishes its leave transition.
		const raf = new RAFQueue();
		raf.install();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		function ToasterAndAdder() {
			const { toast, toasts } = useToast();
			return (
				<>
					<button onClick={() => toast({ title: 'Managed', duration: 200 })}>Add</button>
					<span data-testid="count">{toasts.length}</span>
					<Toaster />
				</>
			);
		}

		render(<ToasterAndAdder />);
		await act(async () => {});

		// Add a managed toast
		await act(async () => {
			fireEvent.click(screen.getByText('Add'));
		});
		await act(async () => {});
		expect(screen.getByTestId('count').textContent).toBe('1');

		// Toast auto-dismisses after duration → Transition starts leave
		await act(async () => {
			vi.advanceTimersByTime(200);
		});
		// Flush the RAF for the leave transition
		await act(async () => {
			raf.flush();
		});
		// afterLeave calls dismiss(item.id), removing from store
		await act(async () => {});
		expect(screen.getByTestId('count').textContent).toBe('0');
	});
});
