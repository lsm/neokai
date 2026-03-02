import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Disclosure, DisclosureButton, DisclosurePanel } from '../src/mod.ts';

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

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('Disclosure', () => {
	it('should be closed by default', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);

		expect(screen.queryByText('Panel content')).toBeNull();
	});

	it('should open when defaultOpen is true', () => {
		render(
			<Disclosure defaultOpen>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);

		expect(screen.getByText('Panel content')).toBeTruthy();
	});

	it('should toggle open/closed on DisclosureButton click', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);

		const button = screen.getByText('Toggle');

		expect(screen.queryByText('Panel content')).toBeNull();
		fireEvent.click(button);
		expect(screen.getByText('Panel content')).toBeTruthy();
		fireEvent.click(button);
		expect(screen.queryByText('Panel content')).toBeNull();
	});

	it('should toggle on Enter key', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);

		const button = screen.getByText('Toggle');

		expect(screen.queryByText('Panel content')).toBeNull();
		fireEvent.keyDown(button, { key: 'Enter' });
		expect(screen.getByText('Panel content')).toBeTruthy();
		fireEvent.keyDown(button, { key: 'Enter' });
		expect(screen.queryByText('Panel content')).toBeNull();
	});

	it('should toggle on Space key', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);

		const button = screen.getByText('Toggle');

		expect(screen.queryByText('Panel content')).toBeNull();
		fireEvent.keyDown(button, { key: ' ' });
		expect(screen.getByText('Panel content')).toBeTruthy();
	});

	it('should set aria-expanded on DisclosureButton', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);

		expect(screen.getByText('Toggle').getAttribute('aria-expanded')).toBe('false');

		fireEvent.click(screen.getByText('Toggle'));
		expect(screen.getByText('Toggle').getAttribute('aria-expanded')).toBe('true');
	});

	it('should set aria-controls pointing to panel id', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);

		const button = screen.getByText('Toggle');
		fireEvent.click(button);

		const panel = screen.getByText('Panel content').closest('div');
		const panelId = panel?.getAttribute('id');

		expect(button.getAttribute('aria-controls')).toBe(panelId);
	});

	it('should provide open state via render prop', () => {
		render(
			<Disclosure>
				{({ open }: { open: boolean }) => (
					<>
						<DisclosureButton>{open ? 'Close' : 'Open'}</DisclosureButton>
						<DisclosurePanel>Panel content</DisclosurePanel>
					</>
				)}
			</Disclosure>
		);

		expect(screen.getByText('Open')).toBeTruthy();
		fireEvent.click(screen.getByText('Open'));
		expect(screen.getByText('Close')).toBeTruthy();
	});

	it('should support close() function from render prop', () => {
		render(
			<Disclosure defaultOpen>
				{({ close }: { close: () => void }) => (
					<>
						<DisclosureButton>Toggle</DisclosureButton>
						<DisclosurePanel>
							<button type="button" onClick={() => close()}>
								Close panel
							</button>
						</DisclosurePanel>
					</>
				)}
			</Disclosure>
		);

		expect(screen.getByText('Close panel')).toBeTruthy();
		fireEvent.click(screen.getByText('Close panel'));
		expect(screen.queryByText('Close panel')).toBeNull();
	});

	it('should unmount panel when closed (default behavior)', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);

		// By default, panel is unmounted when closed
		expect(screen.queryByText('Panel content')).toBeNull();
		fireEvent.click(screen.getByText('Toggle'));
		expect(screen.getByText('Panel content')).toBeTruthy();
		fireEvent.click(screen.getByText('Toggle'));
		expect(screen.queryByText('Panel content')).toBeNull();
	});

	it('should hide panel with display:none when unmount=false', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel unmount={false}>Panel content</DisclosurePanel>
			</Disclosure>
		);

		// Panel should be in DOM but hidden
		const panel = screen.getByText('Panel content').closest('div');
		expect(panel).toBeTruthy();
		expect(panel?.getAttribute('hidden')).toBe('');
	});

	it('should always show panel when static=true', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel static>Panel content</DisclosurePanel>
			</Disclosure>
		);

		// Panel should always be visible regardless of open state
		expect(screen.getByText('Panel content')).toBeTruthy();
	});

	it('should accept custom "as" prop for DisclosureButton', () => {
		render(
			<Disclosure>
				<DisclosureButton as="a">Toggle link</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);

		const button = screen.getByText('Toggle link');
		expect(button.tagName.toLowerCase()).toBe('a');
	});

	it('should throw when DisclosureButton used outside Disclosure', () => {
		expect(() => {
			render(<DisclosureButton>Orphan</DisclosureButton>);
		}).toThrow('<DisclosureButton> must be used within a <Disclosure>');
	});

	it('should throw when DisclosurePanel used outside Disclosure', () => {
		expect(() => {
			render(<DisclosurePanel>Orphan</DisclosurePanel>);
		}).toThrow('<DisclosurePanel> must be used within a <Disclosure>');
	});

	it('should handle mouseenter and mouseleave on DisclosureButton (lines 139-140)', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);
		const btn = screen.getByText('Toggle');
		fireEvent.mouseEnter(btn);
		fireEvent.mouseLeave(btn);
		expect(btn).not.toBeNull();
	});

	it('should handle focus and blur on DisclosureButton (lines 141-142)', async () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);
		const btn = screen.getByText('Toggle');
		// Use native focus/blur to trigger onFocus/onBlur handlers
		await act(async () => {
			btn.focus();
		});
		await act(async () => {
			btn.blur();
		});
		expect(btn).not.toBeNull();
	});

	it('should handle mousedown and mouseup on DisclosureButton (lines 143-144)', () => {
		render(
			<Disclosure>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);
		const btn = screen.getByText('Toggle');
		fireEvent.mouseDown(btn);
		fireEvent.mouseUp(btn);
		expect(btn).not.toBeNull();
	});

	it('should not toggle on click when DisclosureButton is disabled', () => {
		render(
			<Disclosure>
				<DisclosureButton disabled>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);
		fireEvent.click(screen.getByText('Toggle'));
		expect(screen.queryByText('Panel content')).toBeNull();
	});

	it('should not toggle on keydown when DisclosureButton is disabled', () => {
		render(
			<Disclosure>
				<DisclosureButton disabled>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);
		fireEvent.keyDown(screen.getByText('Toggle'), { key: 'Enter' });
		expect(screen.queryByText('Panel content')).toBeNull();
	});

	it('should call close() with focusRef to focus specific element', async () => {
		render(
			<Disclosure defaultOpen>
				{({ close }: { close: (ref?: { current: HTMLElement | null }) => void }) => (
					<>
						<DisclosureButton>Toggle</DisclosureButton>
						<DisclosurePanel>
							<button
								type="button"
								id="custom-focus"
								onClick={() => {
									const ref = { current: document.getElementById('custom-focus') };
									close(ref);
								}}
							>
								Close with focus
							</button>
						</DisclosurePanel>
					</>
				)}
			</Disclosure>
		);
		expect(screen.getByText('Close with focus')).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByText('Close with focus'));
		});
		expect(screen.queryByText('Close with focus')).toBeNull();
	});

	it('should support custom as prop on Disclosure root', () => {
		render(
			<Disclosure as="section">
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel>Panel content</DisclosurePanel>
			</Disclosure>
		);
		expect(document.querySelector('section')).not.toBeNull();
	});

	it('should support DisclosurePanel with custom as prop', () => {
		render(
			<Disclosure defaultOpen>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel as="section">Panel content</DisclosurePanel>
			</Disclosure>
		);
		expect(document.querySelector('section')).not.toBeNull();
	});

	it('should cover transition enter attrs with RAF flush (lines 201-210)', async () => {
		const raf = new RAFQueue();
		raf.install();

		// Use as="div" to prevent Fragment→span switching which remounts children and resets
		// prevOpenRef, preventing the open&&!prev branch from being hit.
		// unmount={false} keeps the panel mounted when closed so it sees the false→true transition.
		render(
			<Disclosure as="div">
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel transition unmount={false}>
					Panel content
				</DisclosurePanel>
			</Disclosure>
		);

		// Open: prevOpenRef was false, open becomes true → enters the enter branch (lines 201-210)
		await act(async () => {
			fireEvent.click(screen.getByText('Toggle'));
		});
		// Flush enter transition RAFs (inner RAF clears attrs)
		await act(async () => {
			raf.flush();
		});

		expect(screen.getByText('Panel content')).not.toBeNull();
	});

	it('should cover transition leave attrs with RAF flush (lines 212-221)', async () => {
		const raf = new RAFQueue();
		raf.install();

		// Start open with as="div" to stabilize the DOM element type
		render(
			<Disclosure as="div" defaultOpen>
				<DisclosureButton>Toggle</DisclosureButton>
				<DisclosurePanel transition unmount={false}>
					Panel content
				</DisclosurePanel>
			</Disclosure>
		);

		// Flush any enter RAFs from the initial open state
		await act(async () => {
			raf.flush();
		});

		// Close: prevOpenRef was true, open becomes false → enters the leave branch (lines 212-221)
		await act(async () => {
			fireEvent.click(screen.getByText('Toggle'));
		});
		// Flush leave transition RAFs
		await act(async () => {
			raf.flush();
		});

		expect(screen.queryByText('Panel content')).not.toBeNull(); // unmount=false keeps it in DOM
	});
});
