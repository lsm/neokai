import { act, cleanup, render, screen } from '@testing-library/preact';
import { useContext } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClosedContext, State } from '../src/internal/open-closed.ts';
import { Transition } from '../src/mod.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// Helper consumer component that reads OpenClosedContext
function OpenClosedConsumer() {
	const state = useContext(OpenClosedContext);
	return (
		<span data-state={state === State.Open ? 'open' : state === State.Closed ? 'closed' : 'null'} />
	);
}

// A queuing RAF that collects callbacks for manual flushing
class RAFQueue {
	callbacks: FrameRequestCallback[] = [];
	private idCounter = 0;

	schedule(cb: FrameRequestCallback): number {
		this.callbacks.push(cb);
		return ++this.idCounter;
	}

	// Run exactly one round of pending RAF callbacks
	flushOne(): void {
		const batch = this.callbacks.splice(0);
		for (const cb of batch) {
			cb(performance.now());
		}
	}

	// Flush all pending callbacks up to maxRounds levels deep
	flush(maxRounds = 20): void {
		for (let i = 0; i < maxRounds; i++) {
			if (this.callbacks.length === 0) break;
			this.flushOne();
		}
	}

	install(): void {
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => this.schedule(cb));
		vi.stubGlobal('cancelAnimationFrame', () => {});
	}
}

// Mock getComputedStyle to return the given transition/animation durations.
// Captures the element it was called on (the transition element) for later use.
function mockComputedStyleCapturing(opts: {
	transitionDuration?: string;
	animationDuration?: string;
}): { getEl: () => HTMLElement | null } {
	let capturedEl: HTMLElement | null = null;
	const result = {
		transitionDuration: opts.transitionDuration ?? '0s',
		animationDuration: opts.animationDuration ?? '0s',
	} as CSSStyleDeclaration;
	vi.stubGlobal('getComputedStyle', (el: HTMLElement) => {
		capturedEl = el;
		return result;
	});
	return { getEl: () => capturedEl };
}

function mockComputedStyle(opts: { transitionDuration?: string; animationDuration?: string }) {
	const result = {
		transitionDuration: opts.transitionDuration ?? '0s',
		animationDuration: opts.animationDuration ?? '0s',
	} as CSSStyleDeclaration;
	vi.stubGlobal('getComputedStyle', () => result);
}

describe('Transition', () => {
	it('should render children when show is true', async () => {
		render(
			<Transition show={true}>
				<span>Visible content</span>
			</Transition>
		);
		await act(async () => {});
		expect(screen.getByText('Visible content')).not.toBeNull();
	});

	it('should not render children when show is false (unmount mode)', async () => {
		render(
			<Transition show={false}>
				<span>Hidden content</span>
			</Transition>
		);
		await act(async () => {});
		expect(screen.queryByText('Hidden content')).toBeNull();
	});

	it('should hide with display:none when show is false and unmount is false', async () => {
		render(
			<Transition show={false} unmount={false}>
				<span>Hidden content</span>
			</Transition>
		);
		await act(async () => {});
		const el = screen.getByText('Hidden content').closest('div');
		expect(el).not.toBeNull();
		// When hidden, the render utility sets hidden attribute and display:none style
		expect(el?.getAttribute('hidden')).toBe('');
	});

	it('should support custom as prop', async () => {
		render(
			<Transition show={true} as="section">
				<span>Section content</span>
			</Transition>
		);
		await act(async () => {});
		const section = document.querySelector('section');
		expect(section).not.toBeNull();
		expect(section?.textContent).toBe('Section content');
	});

	it('should provide open state to OpenClosedContext consumers', async () => {
		render(
			<Transition show={true}>
				<OpenClosedConsumer />
			</Transition>
		);
		await act(async () => {});
		const span = document.querySelector('[data-state]');
		expect(span?.getAttribute('data-state')).toBe('open');
	});

	it('should provide closed state to OpenClosedContext consumers when show is false', async () => {
		render(
			<Transition show={false} unmount={false}>
				<OpenClosedConsumer />
			</Transition>
		);
		await act(async () => {});
		const span = document.querySelector('[data-state]');
		expect(span?.getAttribute('data-state')).toBe('closed');
	});

	it('should not render context wrapper when show is not provided (uncontrolled)', async () => {
		// When show is not provided, Transition renders without OpenClosedContext.Provider
		render(
			<OpenClosedContext.Provider value={State.Open}>
				<Transition>
					<span>Content</span>
				</Transition>
			</OpenClosedContext.Provider>
		);
		await act(async () => {});
		expect(screen.getByText('Content')).not.toBeNull();
	});

	it('should read visibility from OpenClosedContext when show is not provided', async () => {
		// When show is undefined, it reads from context
		render(
			<OpenClosedContext.Provider value={State.Closed}>
				<Transition unmount={false}>
					<span>Content</span>
				</Transition>
			</OpenClosedContext.Provider>
		);
		await act(async () => {});
		// Should be hidden since context says Closed
		const el = screen.getByText('Content').closest('div');
		expect(el?.getAttribute('hidden')).toBe('');
	});

	it('should be visible when context is Open and show is not provided', async () => {
		render(
			<OpenClosedContext.Provider value={State.Open}>
				<Transition>
					<span>Visible from context</span>
				</Transition>
			</OpenClosedContext.Provider>
		);
		await act(async () => {});
		expect(screen.getByText('Visible from context')).not.toBeNull();
	});

	it('should default to visible when no show prop and no context', async () => {
		render(
			<Transition>
				<span>Default visible</span>
			</Transition>
		);
		await act(async () => {});
		expect(screen.getByText('Default visible')).not.toBeNull();
	});

	it('should show element when toggled from hidden to visible', async () => {
		const { rerender } = render(
			<Transition show={false}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true}>
					<span>Content</span>
				</Transition>
			);
		});

		expect(screen.getByText('Content')).not.toBeNull();
	});

	it('should hide element when toggled from visible to hidden (no CSS transition)', async () => {
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0s', animationDuration: '0s' });

		const { rerender } = render(
			<Transition show={true}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {});
		expect(screen.getByText('Content')).not.toBeNull();

		await act(async () => {
			rerender(
				<Transition show={false}>
					<span>Content</span>
				</Transition>
			);
		});
		// Flush: runLeave phase 1 (already ran sync), phase 2 RAF runs waitForTransition with no duration → done() immediately → setShouldRender(false)
		await act(async () => {
			raf.flush();
		});

		expect(screen.queryByText('Content')).toBeNull();
	});

	it('should call beforeEnter callback when entering', async () => {
		const beforeEnter = vi.fn();
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0s', animationDuration: '0s' });

		const { rerender } = render(
			<Transition show={false} beforeEnter={beforeEnter}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true} beforeEnter={beforeEnter}>
					<span>Content</span>
				</Transition>
			);
		});
		await act(async () => {
			raf.flush();
		});

		expect(beforeEnter).toHaveBeenCalled();
	});

	it('should call afterEnter callback when enter completes (no CSS transition)', async () => {
		const afterEnter = vi.fn();
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0s', animationDuration: '0s' });

		const { rerender } = render(
			<Transition show={false} afterEnter={afterEnter}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true} afterEnter={afterEnter}>
					<span>Content</span>
				</Transition>
			);
		});
		await act(async () => {
			raf.flush();
		});

		expect(afterEnter).toHaveBeenCalled();
	});

	it('should call beforeLeave callback when leaving', async () => {
		const beforeLeave = vi.fn();
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0s', animationDuration: '0s' });

		const { rerender } = render(
			<Transition show={true} beforeLeave={beforeLeave}>
				<span>Content</span>
			</Transition>
		);
		await act(async () => {});

		await act(async () => {
			rerender(
				<Transition show={false} beforeLeave={beforeLeave}>
					<span>Content</span>
				</Transition>
			);
		});
		await act(async () => {
			raf.flush();
		});

		expect(beforeLeave).toHaveBeenCalled();
	});

	it('should call afterLeave callback when leave completes (no CSS transition)', async () => {
		const afterLeave = vi.fn();
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0s', animationDuration: '0s' });

		const { rerender } = render(
			<Transition show={true} afterLeave={afterLeave}>
				<span>Content</span>
			</Transition>
		);
		await act(async () => {});

		await act(async () => {
			rerender(
				<Transition show={false} afterLeave={afterLeave}>
					<span>Content</span>
				</Transition>
			);
		});
		await act(async () => {
			raf.flush();
		});

		expect(afterLeave).toHaveBeenCalled();
	});

	it('should run appear transition on initial mount when appear=true and show=true', async () => {
		const beforeEnter = vi.fn();
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0s', animationDuration: '0s' });

		render(
			<Transition show={true} appear={true} beforeEnter={beforeEnter}>
				<span>Appear content</span>
			</Transition>
		);

		await act(async () => {});
		await act(async () => {
			raf.flush();
		});

		expect(screen.getByText('Appear content')).not.toBeNull();
		expect(beforeEnter).toHaveBeenCalled();
	});

	it('should not run appear transition on initial mount when appear=false', async () => {
		const beforeEnter = vi.fn();
		const raf = new RAFQueue();
		raf.install();

		render(
			<Transition show={true} appear={false} beforeEnter={beforeEnter}>
				<span>No appear content</span>
			</Transition>
		);

		await act(async () => {});
		await act(async () => {
			raf.flush();
		});

		expect(screen.getByText('No appear content')).not.toBeNull();
		// beforeEnter should NOT be called when appear=false
		expect(beforeEnter).not.toHaveBeenCalled();
	});

	it('should wait for transitionend event before calling afterEnter', async () => {
		const raf = new RAFQueue();
		raf.install();
		// Mock real transition duration and capture the element the component attaches to
		const { getEl } = mockComputedStyleCapturing({
			transitionDuration: '0.3s',
			animationDuration: '0s',
		});

		const afterEnter = vi.fn();

		const { rerender } = render(
			<Transition show={false} afterEnter={afterEnter}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true} afterEnter={afterEnter}>
					<span>Content</span>
				</Transition>
			);
		});
		// Flush both RAF levels so waitForTransition attaches transitionend listener
		await act(async () => {
			raf.flush();
		});

		// afterEnter not yet called - waiting for transitionend
		expect(afterEnter).not.toHaveBeenCalled();

		// Dispatch transitionend on the actual element (captured via getComputedStyle mock)
		await act(async () => {
			const el = getEl();
			if (el) {
				el.dispatchEvent(new Event('transitionend', { bubbles: false }));
			}
		});

		expect(afterEnter).toHaveBeenCalled();
	});

	it('should wait for animationend event before calling afterEnter', async () => {
		const raf = new RAFQueue();
		raf.install();
		// transitionDuration must be '' (falsy) so || operator falls through to animationDuration
		const { getEl } = mockComputedStyleCapturing({
			transitionDuration: '',
			animationDuration: '0.5s',
		});

		const afterEnter = vi.fn();

		const { rerender } = render(
			<Transition show={false} afterEnter={afterEnter}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true} afterEnter={afterEnter}>
					<span>Content</span>
				</Transition>
			);
		});
		await act(async () => {
			raf.flush();
		});

		// Not yet called
		expect(afterEnter).not.toHaveBeenCalled();

		// Dispatch animationend event
		await act(async () => {
			const el = getEl();
			if (el) {
				el.dispatchEvent(new Event('animationend', { bubbles: false }));
			}
		});

		expect(afterEnter).toHaveBeenCalled();
	});

	it('should forward function ref to element', async () => {
		let capturedRef: HTMLElement | null = null;

		await act(async () => {
			render(
				<Transition
					show={true}
					ref={(el: HTMLElement | null) => {
						capturedRef = el;
					}}
				>
					<span>Content</span>
				</Transition>
			);
		});

		expect(capturedRef).not.toBeNull();
	});

	it('should forward object ref to element', async () => {
		const ref = { current: null as HTMLElement | null };

		await act(async () => {
			render(
				<Transition show={true} ref={ref}>
					<span>Content</span>
				</Transition>
			);
		});

		expect(ref.current).not.toBeNull();
	});

	it('should ignore transitionend from child elements', async () => {
		const raf = new RAFQueue();
		raf.install();
		const { getEl } = mockComputedStyleCapturing({
			transitionDuration: '0.3s',
			animationDuration: '0s',
		});

		const afterEnter = vi.fn();

		const { rerender } = render(
			<Transition show={false} afterEnter={afterEnter}>
				<span id="inner">Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true} afterEnter={afterEnter}>
					<span id="inner">Content</span>
				</Transition>
			);
		});
		await act(async () => {
			raf.flush();
		});

		// Confirm the transition element was captured
		const transitionEl = getEl();
		expect(transitionEl).not.toBeNull();

		// Dispatch transitionend from child element - should be ignored (target !== el)
		await act(async () => {
			const inner = document.querySelector('#inner');
			if (inner) {
				inner.dispatchEvent(new Event('transitionend', { bubbles: true }));
			}
		});

		// afterEnter should NOT have been called since event.target is child, not el
		expect(afterEnter).not.toHaveBeenCalled();
	});

	it('should set data-leave and data-transition attributes synchronously in runLeave', async () => {
		const raf = new RAFQueue();
		raf.install();
		// Capture the element via getComputedStyle mock
		const { getEl } = mockComputedStyleCapturing({
			transitionDuration: '0.3s',
			animationDuration: '0s',
		});

		const { rerender } = render(
			<Transition show={true}>
				<span>Content</span>
			</Transition>
		);
		await act(async () => {});

		// runLeave is called synchronously from useEffect when visible goes false
		await act(async () => {
			rerender(
				<Transition show={false}>
					<span>Content</span>
				</Transition>
			);
		});

		// runLeave sets phase 1 attrs synchronously, then schedules RAF for phase 2
		// getComputedStyle isn't called until RAF2, so grab the element by data-leave attr
		const el = document.querySelector('[data-leave]');
		expect(el).not.toBeNull();
		expect(el?.getAttribute('data-leave')).toBe('');
		expect(el?.getAttribute('data-transition')).toBe('');
		// suppress unused warning
		void getEl;
	});

	it('should complete leave transition when transitionend fires after leave RAF', async () => {
		const raf = new RAFQueue();
		raf.install();
		const { getEl } = mockComputedStyleCapturing({
			transitionDuration: '0.3s',
			animationDuration: '0s',
		});

		const afterLeave = vi.fn();

		const { rerender } = render(
			<Transition show={true} afterLeave={afterLeave}>
				<span>Content</span>
			</Transition>
		);
		await act(async () => {});

		await act(async () => {
			rerender(
				<Transition show={false} afterLeave={afterLeave}>
					<span>Content</span>
				</Transition>
			);
		});
		// Flush phase 2 RAF (adds data-closed, calls waitForTransition)
		await act(async () => {
			raf.flush();
		});

		// afterLeave not yet called - waiting for transitionend
		expect(afterLeave).not.toHaveBeenCalled();

		// Dispatch transitionend on the captured element
		await act(async () => {
			const el = getEl();
			if (el) {
				el.dispatchEvent(new Event('transitionend', { bubbles: false }));
			}
		});

		expect(afterLeave).toHaveBeenCalled();
	});

	it('should not unmount element when show=false and unmount=false (initial render)', async () => {
		render(
			<Transition show={false} unmount={false}>
				<span>Always in DOM</span>
			</Transition>
		);
		await act(async () => {});
		const el = screen.getByText('Always in DOM');
		expect(el).not.toBeNull();
	});

	it('should initially not render when show=false and unmount=true (default)', async () => {
		render(
			<Transition show={false}>
				<span>Hidden initially</span>
			</Transition>
		);
		await act(async () => {});
		expect(screen.queryByText('Hidden initially')).toBeNull();
	});

	it('should set data-enter, data-closed, data-transition in runEnter phase 1', async () => {
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0.3s', animationDuration: '0s' });

		const { rerender } = render(
			<Transition show={false}>
				<span>Content</span>
			</Transition>
		);

		// Trigger enter — useEffect schedules RAF1 → runEnter
		await act(async () => {
			rerender(
				<Transition show={true}>
					<span>Content</span>
				</Transition>
			);
		});

		// Flush RAF1 only (runs runEnter, which sets phase 1 attrs and queues RAF2)
		await act(async () => {
			raf.flushOne();
		});

		// After runEnter runs (phase 1), before RAF2: data-enter, data-closed, data-transition set
		const el = document.querySelector('[data-enter]');
		expect(el).not.toBeNull();
		expect(el?.getAttribute('data-closed')).toBe('');
		expect(el?.getAttribute('data-transition')).toBe('');
	});

	it('should remove data-closed in phase 2 of enter transition', async () => {
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0.3s', animationDuration: '0s' });

		const { rerender } = render(
			<Transition show={false}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true}>
					<span>Content</span>
				</Transition>
			);
		});

		// Flush RAF1 (runEnter sets phase 1) only
		await act(async () => {
			raf.flushOne();
		});
		// Now data-enter, data-closed, data-transition are set
		// Flush RAF2 (removes data-closed)
		await act(async () => {
			raf.flushOne();
		});

		// After phase 2: data-closed removed, data-enter still present (waiting for transitionend)
		const el = document.querySelector('[data-enter]');
		expect(el).not.toBeNull();
		expect(el?.getAttribute('data-closed')).toBeNull();
		expect(el?.getAttribute('data-transition')).toBe('');
	});

	it('should remove data-enter and data-transition after enter transition completes', async () => {
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0s', animationDuration: '0s' });

		const { rerender } = render(
			<Transition show={false}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true}>
					<span>Content</span>
				</Transition>
			);
		});
		// Flush both levels. No CSS transition → done() called immediately → attrs removed
		await act(async () => {
			raf.flush();
		});

		// After transition completes: no data-enter or data-transition anywhere in DOM
		expect(document.querySelector('[data-enter]')).toBeNull();
		expect(document.querySelector('[data-transition]')).toBeNull();
	});

	it('should cancel in-flight RAF when visibility reverses mid-transition', async () => {
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0.3s', animationDuration: '0s' });

		const afterEnter = vi.fn();
		const beforeLeave = vi.fn();

		const { rerender } = render(
			<Transition show={false} afterEnter={afterEnter} beforeLeave={beforeLeave}>
				<span>Content</span>
			</Transition>
		);

		// Start enter — RAF1 pending, runEnter not yet called
		await act(async () => {
			rerender(
				<Transition show={true} afterEnter={afterEnter} beforeLeave={beforeLeave}>
					<span>Content</span>
				</Transition>
			);
		});
		// RAF1 is queued. Now immediately start leave before RAF runs.
		await act(async () => {
			rerender(
				<Transition show={false} afterEnter={afterEnter} beforeLeave={beforeLeave}>
					<span>Content</span>
				</Transition>
			);
		});
		// Flush all RAFs - the pending enter RAF should have been canceled by leave
		await act(async () => {
			raf.flush();
		});

		// Leave should have called beforeLeave
		expect(beforeLeave).toHaveBeenCalled();
		// afterEnter should NOT be called since enter was canceled
		expect(afterEnter).not.toHaveBeenCalled();
	});
});

describe('Transition - hasTransition utility', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('should skip waitForTransition when no CSS transition duration', async () => {
		const raf = new RAFQueue();
		raf.install();
		mockComputedStyle({ transitionDuration: '0s', animationDuration: '0s' });

		const afterEnter = vi.fn();

		const { rerender } = render(
			<Transition show={false} afterEnter={afterEnter}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true} afterEnter={afterEnter}>
					<span>Content</span>
				</Transition>
			);
		});
		await act(async () => {
			raf.flush();
		});

		// With no transition, afterEnter should be called immediately (no event needed)
		expect(afterEnter).toHaveBeenCalled();
	});

	it('should detect transition from transitionDuration with multiple values', async () => {
		const raf = new RAFQueue();
		raf.install();
		// Multiple values - one is non-zero
		const { getEl } = mockComputedStyleCapturing({
			transitionDuration: '0s, 0.3s',
			animationDuration: '0s',
		});

		const afterEnter = vi.fn();

		const { rerender } = render(
			<Transition show={false} afterEnter={afterEnter}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true} afterEnter={afterEnter}>
					<span>Content</span>
				</Transition>
			);
		});
		await act(async () => {
			raf.flush();
		});

		// Has transition, so afterEnter waits for transitionend
		expect(afterEnter).not.toHaveBeenCalled();

		// Fire transitionend on the captured element
		await act(async () => {
			const el = getEl();
			if (el) {
				el.dispatchEvent(new Event('transitionend', { bubbles: false }));
			}
		});

		expect(afterEnter).toHaveBeenCalled();
	});

	it('should detect animation from animationDuration', async () => {
		const raf = new RAFQueue();
		raf.install();
		const { getEl } = mockComputedStyleCapturing({
			transitionDuration: '',
			animationDuration: '0.5s',
		});

		const afterEnter = vi.fn();

		const { rerender } = render(
			<Transition show={false} afterEnter={afterEnter}>
				<span>Content</span>
			</Transition>
		);

		await act(async () => {
			rerender(
				<Transition show={true} afterEnter={afterEnter}>
					<span>Content</span>
				</Transition>
			);
		});
		await act(async () => {
			raf.flush();
		});

		// Has animation, so afterEnter should NOT be called until animationend fires
		expect(afterEnter).not.toHaveBeenCalled();

		// Now fire the animationend event
		await act(async () => {
			const el = getEl();
			if (el) {
				el.dispatchEvent(new Event('animationend', { bubbles: false }));
			}
		});

		expect(afterEnter).toHaveBeenCalled();
	});
});
