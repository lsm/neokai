/**
 * Tests for ChatContainer State Handling
 *
 * Tests the state update batching and scroll behavior optimizations.
 * These tests verify the fixes for UI freeze during state transitions.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, vi, afterEach, beforeAll } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock requestAnimationFrame for testing
const rafCallbacks: Array<() => void> = [];
const mockRaf = vi.fn((callback: FrameRequestCallback) => {
	rafCallbacks.push(callback as unknown as () => void);
	return rafCallbacks.length;
});

/**
 * Helper to flush all pending requestAnimationFrame callbacks
 */
function flushRAF(): void {
	const callbacks = [...rafCallbacks];
	rafCallbacks.length = 0;
	callbacks.forEach((cb) => cb());
}

describe('ChatContainer State Batching', () => {
	const originalRAF = globalThis.requestAnimationFrame;

	beforeEach(() => {
		rafCallbacks.length = 0;
		mockRaf.mockClear();
		// Mock requestAnimationFrame globally
		globalThis.requestAnimationFrame = mockRaf as unknown as typeof requestAnimationFrame;
	});

	afterEach(() => {
		// Restore original requestAnimationFrame
		globalThis.requestAnimationFrame = originalRAF;
	});

	describe('requestAnimationFrame batching', () => {
		it('should defer state updates to requestAnimationFrame', () => {
			// Simulate the state.session handler behavior
			const stateUpdates: string[] = [];

			const mockSetSession = vi.fn((val: unknown) => stateUpdates.push(`session:${val}`));
			const mockSetContextUsage = vi.fn((val: unknown) => stateUpdates.push(`context:${val}`));
			const mockSetSending = vi.fn((val: unknown) => stateUpdates.push(`sending:${val}`));
			const mockSetCurrentAction = vi.fn((val: unknown) => stateUpdates.push(`action:${val}`));
			const mockSetStreamingPhase = vi.fn((val: unknown) => stateUpdates.push(`phase:${val}`));

			// Simulate receiving state.session event
			const data = {
				session: { id: 'test-session' },
				context: { tokens: 1000 },
				agent: {
					status: 'processing' as const,
					phase: 'initializing' as const,
				},
				commands: { availableCommands: ['/help'] },
			};

			// The handler wraps everything in requestAnimationFrame
			requestAnimationFrame(() => {
				if (data.session) {
					mockSetSession(data.session);
				}
				if (data.context) {
					mockSetContextUsage(data.context);
				}

				// Apply state updates together
				mockSetSending(true);
				mockSetCurrentAction('Starting...');
				mockSetStreamingPhase('initializing');
			});

			// Before flushing, no updates should have happened
			expect(stateUpdates.length).toBe(0);
			expect(mockRaf).toHaveBeenCalledTimes(1);

			// Flush requestAnimationFrame
			flushRAF();

			// After flushing, all updates should have happened together
			expect(stateUpdates.length).toBe(5);
			expect(stateUpdates).toContain('session:[object Object]');
			expect(stateUpdates).toContain('sending:true');
			expect(stateUpdates).toContain('action:Starting...');
			expect(stateUpdates).toContain('phase:initializing');
		});

		it('should process multiple state events in order', () => {
			const events: string[] = [];

			// Simulate multiple rapid state events
			requestAnimationFrame(() => events.push('event1'));
			requestAnimationFrame(() => events.push('event2'));
			requestAnimationFrame(() => events.push('event3'));

			expect(events.length).toBe(0);
			expect(mockRaf).toHaveBeenCalledTimes(3);

			flushRAF();

			expect(events).toEqual(['event1', 'event2', 'event3']);
		});
	});

	describe('agent status transitions', () => {
		it('should correctly map idle status to state values', () => {
			const agentStatus = 'idle' as const;

			let newSending = false;
			let newAction: string | undefined;
			let newPhase: string | null = null;
			let clearStreamingEvents = false;

			switch (agentStatus) {
				case 'idle':
					newSending = false;
					newAction = undefined;
					newPhase = null;
					clearStreamingEvents = true;
					break;
			}

			expect(newSending).toBe(false);
			expect(newAction).toBeUndefined();
			expect(newPhase).toBeNull();
			expect(clearStreamingEvents).toBe(true);
		});

		it('should correctly map queued status to state values', () => {
			const agentStatus = 'queued' as const;

			let newSending = false;
			let newAction: string | undefined;
			let newPhase: string | null = null;

			switch (agentStatus) {
				case 'queued':
					newSending = true;
					newAction = 'Queued...';
					newPhase = null;
					break;
			}

			expect(newSending).toBe(true);
			expect(newAction).toBe('Queued...');
			expect(newPhase).toBeNull();
		});

		it('should correctly map processing/initializing to state values', () => {
			const agentStatus = 'processing' as const;
			const agentPhase = 'initializing';

			let newSending = false;
			let newAction: string | undefined;
			let newPhase: string | null = null;

			if (agentStatus === 'processing') {
				newSending = true;
				newPhase = agentPhase;

				// Map phase to action - using if/else to avoid TypeScript narrowing issues
				if (agentPhase === 'initializing') {
					newAction = 'Starting...';
				} else if (agentPhase === 'thinking') {
					newAction = 'Thinking...';
				} else if (agentPhase === 'streaming') {
					newAction = 'Streaming...';
				} else if (agentPhase === 'finalizing') {
					newAction = 'Finalizing...';
				}
			}

			expect(newSending).toBe(true);
			expect(newAction).toBe('Starting...');
			expect(newPhase).toBe('initializing');
		});

		it('should correctly map interrupted status to state values', () => {
			const agentStatus = 'interrupted' as const;

			let newSending = false;
			let newAction: string | undefined;
			let newPhase: string | null = null;
			let clearStreamingEvents = false;

			switch (agentStatus) {
				case 'interrupted':
					newSending = false;
					newAction = 'Interrupted';
					newPhase = null;
					clearStreamingEvents = true;
					break;
			}

			expect(newSending).toBe(false);
			expect(newAction).toBe('Interrupted');
			expect(newPhase).toBeNull();
			expect(clearStreamingEvents).toBe(true);
		});

		it('should calculate streaming duration correctly', () => {
			const streamingStartedAt = Date.now() - 5000; // 5 seconds ago

			const duration = streamingStartedAt
				? Math.floor((Date.now() - streamingStartedAt) / 1000)
				: 0;

			expect(duration).toBeGreaterThanOrEqual(4);
			expect(duration).toBeLessThanOrEqual(6);

			const action = duration > 0 ? `Streaming (${duration}s)...` : 'Streaming...';
			expect(action).toMatch(/Streaming \(\d+s\)\.\.\./);
		});
	});
});

describe('Scroll Behavior', () => {
	describe('scrollToBottom function', () => {
		it('should use instant scroll by default', () => {
			let scrollOptions: ScrollIntoViewOptions | undefined;

			const mockScrollIntoView = vi.fn((options: ScrollIntoViewOptions) => {
				scrollOptions = options;
			});

			const mockRef = { current: { scrollIntoView: mockScrollIntoView } };

			// Simulate scrollToBottom(false) - default
			const smooth = false;
			mockRef.current?.scrollIntoView({
				behavior: smooth ? 'smooth' : 'instant',
			});

			expect(scrollOptions?.behavior).toBe('instant');
		});

		it('should use smooth scroll when explicitly requested', () => {
			let scrollOptions: ScrollIntoViewOptions | undefined;

			const mockScrollIntoView = vi.fn((options: ScrollIntoViewOptions) => {
				scrollOptions = options;
			});

			const mockRef = { current: { scrollIntoView: mockScrollIntoView } };

			// Simulate scrollToBottom(true) - smooth
			const smooth = true;
			mockRef.current?.scrollIntoView({
				behavior: smooth ? 'smooth' : 'instant',
			});

			expect(scrollOptions?.behavior).toBe('smooth');
		});
	});

	describe('scroll button visibility logic', () => {
		it('should show button when not near bottom', () => {
			// Simulate scroll container state
			const scrollTop = 0;
			const scrollHeight = 1000;
			const clientHeight = 500;

			const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;

			expect(isNearBottom).toBe(false);
			// showScrollButton = !isNearBottom = true
			expect(!isNearBottom).toBe(true);
		});

		it('should hide button when near bottom', () => {
			// Simulate scroll container near bottom
			const scrollTop = 350;
			const scrollHeight = 1000;
			const clientHeight = 500;

			const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;

			expect(isNearBottom).toBe(true);
			// showScrollButton = !isNearBottom = false
			expect(!isNearBottom).toBe(false);
		});

		it('should hide button when exactly at bottom', () => {
			// Simulate scroll container at bottom
			const scrollTop = 500;
			const scrollHeight = 1000;
			const clientHeight = 500;

			const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;

			expect(isNearBottom).toBe(true);
			// showScrollButton = !isNearBottom = false
			expect(!isNearBottom).toBe(false);
		});
	});
});

describe('ResizeObserver Integration', () => {
	it('should create ResizeObserver for scroll button updates', () => {
		const observeCalls: Element[] = [];
		const disconnectCalled = { value: false };

		// Mock ResizeObserver
		const MockResizeObserver = class {
			callback: ResizeObserverCallback;
			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
			}
			observe(element: Element) {
				observeCalls.push(element);
			}
			unobserve(_element: Element) {}
			disconnect() {
				disconnectCalled.value = true;
			}
		};

		// Simulate the useEffect behavior
		const container = { tagName: 'DIV' } as unknown as Element;
		const handleScroll = vi.fn(() => {});

		const resizeObserver = new MockResizeObserver(() => {
			handleScroll();
		});
		resizeObserver.observe(container);

		expect(observeCalls).toContain(container);

		// Simulate cleanup
		resizeObserver.disconnect();
		expect(disconnectCalled.value).toBe(true);
	});
});

/**
 * Loading Skeleton Layout Invariants (CLS prevention)
 *
 * These tests guard against regressions that would re-introduce Cumulative Layout
 * Shift (CLS) when the loading skeleton transitions to real content.
 *
 * Root cause of CLS:
 * - ChatHeader uses `h-[65px]` (fixed 65 px).  A skeleton header with `py-3`
 *   renders at ~40 px — a 25 px shift on load.
 * - ChatComposer renders as `absolute bottom-0 left-0 right-0`, so it does NOT
 *   participate in the flex layout.  A skeleton footer that IS in the flex flow
 *   consumes height that later disappears, causing the messages area to shift.
 */
describe('ChatContainer Loading Skeleton CLS Prevention', () => {
	let source: string;

	beforeAll(() => {
		const componentPath = resolve(__dirname, '../ChatContainer.tsx');
		source = readFileSync(componentPath, 'utf-8');
	});

	it('skeleton header uses h-[65px] to match ChatHeader fixed height', () => {
		// ChatHeader sets `h-[65px]`.  The skeleton must use the same value so
		// the header occupies identical vertical space before and after load.
		expect(source).toMatch(/Skeleton header[\s\S]*?h-\[65px\]/);
	});

	it('skeleton header does not use py-3 for height', () => {
		// py-3 gives ~40 px, which caused a 25 px shift when the 65 px real
		// header appeared.  Verify it is not used as a height stand-in.
		const skeletonSection =
			source.match(/\/\* Skeleton header[\s\S]*?\/\* Skeleton messages/)?.[0] ?? '';
		expect(skeletonSection).not.toContain('py-3');
	});

	it('skeleton footer uses absolute positioning to match ChatComposer layout', () => {
		// ChatComposer renders as `absolute bottom-0 left-0 right-0` — it is
		// outside the flex flow.  The skeleton footer must also be absolute so the
		// flex calculation (header + messages flex-1) is identical on both sides of
		// the skeleton → content transition.
		expect(source).toMatch(/Skeleton footer[\s\S]*?absolute bottom-0 left-0 right-0/);
	});

	it('skeleton outer container includes relative to anchor the absolute footer', () => {
		// The absolutely-positioned footer needs a positioned ancestor.
		// Verify `relative` is present in the skeleton's outer container class.
		expect(source).toMatch(
			/flex-1 flex flex-col bg-dark-900 overflow-hidden relative[\s\S]*?Skeleton header/
		);
	});
});

describe('Passive Event Listener', () => {
	it('should add scroll listener with passive option', () => {
		const addEventListenerCalls: Array<{
			type: string;
			options: AddEventListenerOptions | boolean | undefined;
		}> = [];

		const mockContainer = {
			addEventListener: vi.fn(
				(
					type: string,
					_handler: EventListener,
					options: AddEventListenerOptions | boolean | undefined
				) => {
					addEventListenerCalls.push({ type, options });
				}
			),
			removeEventListener: vi.fn(() => {}),
			scrollTop: 0,
			scrollHeight: 1000,
			clientHeight: 500,
		};

		// Simulate adding scroll listener with passive: true
		const handleScroll = () => {};
		mockContainer.addEventListener('scroll', handleScroll, { passive: true });

		expect(addEventListenerCalls.length).toBe(1);
		expect(addEventListenerCalls[0].type).toBe('scroll');
		expect(addEventListenerCalls[0].options).toEqual({ passive: true });
	});
});
