import type { ComponentChildren, Ref, VNode } from 'preact';
import { createElement } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { OpenClosedContext, State, useOpenClosed } from '../../internal/open-closed.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';

// Check if element has CSS transitions or animations
function hasTransition(el: HTMLElement): boolean {
	const style = getComputedStyle(el);
	const dur = style.transitionDuration || style.animationDuration || '';
	return dur.split(',').some((d) => parseFloat(d) > 0);
}

// Wait for transition/animation to end, returns cleanup fn
function waitForTransition(el: HTMLElement, done: () => void): () => void {
	if (!hasTransition(el)) {
		done();
		return () => {};
	}

	const onEnd = (event: Event) => {
		if (event.target !== el) return;
		cleanup();
		done();
	};

	const cleanup = () => {
		el.removeEventListener('transitionend', onEnd);
		el.removeEventListener('animationend', onEnd);
	};

	el.addEventListener('transitionend', onEnd);
	el.addEventListener('animationend', onEnd);

	return cleanup;
}

export interface TransitionProps {
	show?: boolean;
	appear?: boolean;
	as?: ElementType;
	unmount?: boolean;
	children?: ComponentChildren | ((ref: Ref<HTMLElement>) => VNode);
	beforeEnter?: () => void;
	afterEnter?: () => void;
	beforeLeave?: () => void;
	afterLeave?: () => void;
	[key: string]: unknown;
}

function TransitionImpl(props: TransitionProps & { ref?: Ref<HTMLElement> }): VNode | null {
	const {
		show,
		appear = false,
		as: Tag = 'div',
		unmount = true,
		children,
		beforeEnter,
		afterEnter,
		beforeLeave,
		afterLeave,
		ref: forwardedRef,
		...theirProps
	} = props;

	// Read from context if `show` not provided
	const openClosedState = useOpenClosed();
	const isControlled = show !== undefined;

	// Resolve the actual visible state
	const visible = isControlled
		? (show ?? false)
		: openClosedState !== null
			? openClosedState === State.Open
			: true;

	const elRef = useRef<HTMLElement | null>(null);
	const cleanupRef = useRef<(() => void) | null>(null);
	const rafRef = useRef<number | null>(null);

	// Track whether this is the initial mount
	const isMounted = useRef(false);

	// Track whether we should render the element (for unmount support)
	const [shouldRender, setShouldRender] = useState(visible);

	// Merge the forwarded ref with our internal ref
	const setRef = useCallback(
		(el: HTMLElement | null) => {
			elRef.current = el;
			if (typeof forwardedRef === 'function') {
				forwardedRef(el);
			} else if (forwardedRef && typeof forwardedRef === 'object') {
				(forwardedRef as { current: HTMLElement | null }).current = el;
			}
		},
		[forwardedRef]
	);

	// Cancel any in-flight animation frame or transition listener
	const cancelPending = useCallback(() => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
		if (cleanupRef.current) {
			cleanupRef.current();
			cleanupRef.current = null;
		}
	}, []);

	// Run enter transition
	const runEnter = useCallback(() => {
		const el = elRef.current;
		if (!el) return;

		cancelPending();
		beforeEnter?.();

		// Phase 1: set data-closed + data-enter + data-transition
		el.setAttribute('data-closed', '');
		el.setAttribute('data-enter', '');
		el.setAttribute('data-transition', '');

		// Phase 2: next frame — remove data-closed to trigger CSS transition
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = null;
			el.removeAttribute('data-closed');

			// Wait for transition to finish
			cleanupRef.current = waitForTransition(el, () => {
				cleanupRef.current = null;
				el.removeAttribute('data-enter');
				el.removeAttribute('data-transition');
				afterEnter?.();
			});
		});
	}, [cancelPending, beforeEnter, afterEnter]);

	// Run leave transition
	const runLeave = useCallback(() => {
		const el = elRef.current;
		if (!el) return;

		cancelPending();
		beforeLeave?.();

		// Phase 1: set data-leave + data-transition
		el.setAttribute('data-leave', '');
		el.setAttribute('data-transition', '');

		// Phase 2: next frame — set data-closed to trigger CSS transition
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = null;
			el.setAttribute('data-closed', '');

			// Wait for transition to finish
			cleanupRef.current = waitForTransition(el, () => {
				cleanupRef.current = null;
				el.removeAttribute('data-leave');
				el.removeAttribute('data-transition');
				afterLeave?.();
				setShouldRender(false);
			});
		});
	}, [cancelPending, beforeLeave, afterLeave]);

	// React to visibility changes
	useEffect(() => {
		if (!isMounted.current) {
			isMounted.current = true;
			if (visible) {
				setShouldRender(true);
				if (appear) {
					// Element is already in DOM after first render, run enter immediately
					runEnter();
				}
			} else {
				setShouldRender(false);
			}
			return;
		}

		if (visible) {
			setShouldRender(true);
			// runEnter needs the element, defer to after render
			const id = requestAnimationFrame(() => {
				runEnter();
			});
			rafRef.current = id;
		} else {
			runLeave();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			cancelPending();
		};
	}, [cancelPending]);

	const slot: Record<string, unknown> = {};

	const ourProps: Record<string, unknown> = {
		ref: setRef,
	};

	// When we need to provide context (show prop is present), wrap children
	const contextValue = visible ? State.Open : State.Closed;

	const renderResult = render({
		ourProps,
		theirProps: { as: Tag, unmount, children, ...theirProps },
		slot,
		defaultTag: 'div',
		features: Features.RenderStrategy,
		visible: shouldRender,
		name: 'Transition',
	});

	if (isControlled) {
		return createElement(
			OpenClosedContext.Provider,
			{ value: contextValue },
			renderResult
		) as VNode;
	}

	return renderResult;
}

TransitionImpl.displayName = 'Transition';

export const Transition = TransitionImpl;
