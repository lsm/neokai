import type { RefObject } from 'preact';
import { createContext, createElement, Fragment } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { CloseContext } from '../../hooks/use-close.ts';
import { OpenClosedContext, State } from '../../internal/open-closed.ts';
import { Portal } from '../../internal/portal.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useEscape } from '../../internal/use-escape.ts';
import { useFocusTrap } from '../../internal/use-focus-trap.ts';
import { useId } from '../../internal/use-id.ts';
import { useOutsideClick } from '../../internal/use-outside-click.ts';

// --- Types ---

interface PopoverState {
	open: boolean;
	toggle: () => void;
	close: (focusRef?: { current: HTMLElement | null }) => void;
	buttonRef: RefObject<HTMLElement | null>;
	panelRef: RefObject<HTMLElement | null>;
	buttonId: string;
	panelId: string;
}

// --- Context ---

const PopoverContext = createContext<PopoverState | null>(null);
PopoverContext.displayName = 'PopoverContext';

function usePopoverContext(component: string): PopoverState {
	const ctx = useContext(PopoverContext);
	if (ctx === null) {
		throw new Error(`<${component}> must be used within a <Popover>`);
	}
	return ctx;
}

// --- Transition attributes helper ---

function useTransitionAttrs(open: boolean, transition: boolean) {
	const [transitionAttrs, setTransitionAttrs] = useState<Record<string, ''>>({});
	const prevOpenRef = useRef(open);

	useEffect(() => {
		if (!transition) {
			setTransitionAttrs({});
			return;
		}

		const prev = prevOpenRef.current;
		prevOpenRef.current = open;

		if (open && !prev) {
			setTransitionAttrs({ 'data-transition': '', 'data-enter': '' });
			const raf = requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setTransitionAttrs({});
				});
			});
			return () => cancelAnimationFrame(raf);
		}

		if (!open && prev) {
			setTransitionAttrs({ 'data-transition': '', 'data-leave': '', 'data-closed': '' });
			const raf = requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setTransitionAttrs({ 'data-closed': '' });
				});
			});
			return () => cancelAnimationFrame(raf);
		}

		if (!open) {
			setTransitionAttrs({ 'data-closed': '' });
		}
	}, [open, transition]);

	return transitionAttrs;
}

// --- Popover (root) ---

interface PopoverProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function PopoverFn({ as: Tag = Fragment, children, ...rest }: PopoverProps) {
	const [open, setOpen] = useState(false);
	const buttonId = useId();
	const panelId = useId();
	const buttonRef = useRef<HTMLElement | null>(null);
	const panelRef = useRef<HTMLElement | null>(null);

	const toggle = useCallback(() => setOpen((v) => !v), []);

	const close = useCallback((focusRef?: { current: HTMLElement | null }) => {
		setOpen(false);
		const target = focusRef?.current ?? buttonRef.current;
		if (target) {
			requestAnimationFrame(() => {
				target.focus();
			});
		}
	}, []);

	const ctx: PopoverState = {
		open,
		toggle,
		close,
		buttonRef,
		panelRef,
		buttonId,
		panelId,
	};

	const slot = { open, close };

	return createElement(
		PopoverContext.Provider,
		{ value: ctx },
		createElement(
			OpenClosedContext.Provider,
			{ value: open ? State.Open : State.Closed },
			createElement(
				CloseContext.Provider,
				{ value: close },
				render({
					ourProps: {},
					theirProps: { as: Tag, children, ...rest },
					slot,
					defaultTag: Fragment,
					name: 'Popover',
				})
			)
		)
	);
}

PopoverFn.displayName = 'Popover';
export const Popover = PopoverFn;

// --- PopoverButton ---

interface PopoverButtonProps {
	as?: ElementType;
	disabled?: boolean;
	autoFocus?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function PopoverButtonFn({
	as: Tag = 'button',
	disabled = false,
	autoFocus = false,
	children,
	...rest
}: PopoverButtonProps) {
	const { open, toggle, buttonRef, buttonId, panelId } = usePopoverContext('PopoverButton');

	const [hover, setHover] = useState(false);
	const [focus, setFocus] = useState(false);
	const [active, setActive] = useState(false);

	const handleClick = useCallback(
		(e: MouseEvent) => {
			if (disabled) return;
			e.preventDefault();
			toggle();
		},
		[disabled, toggle]
	);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (disabled) return;
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggle();
			}
		},
		[disabled, toggle]
	);

	const ourProps: Record<string, unknown> = {
		id: buttonId,
		ref: buttonRef,
		'aria-expanded': open,
		'aria-controls': panelId,
		autoFocus,
		disabled: disabled || undefined,
		onClick: handleClick,
		onKeyDown: handleKeyDown,
		onMouseEnter: () => setHover(true),
		onMouseLeave: () => setHover(false),
		onFocus: () => setFocus(true),
		onBlur: () => setFocus(false),
		onMouseDown: () => setActive(true),
		onMouseUp: () => setActive(false),
	};

	const slot = { open, hover, focus, active, autofocus: autoFocus, disabled };

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'button',
		name: 'PopoverButton',
	});
}

PopoverButtonFn.displayName = 'PopoverButton';
export const PopoverButton = PopoverButtonFn;

// --- PopoverPanel ---

interface PopoverPanelProps {
	as?: ElementType;
	transition?: boolean;
	static?: boolean;
	unmount?: boolean;
	anchor?: string;
	portal?: boolean;
	modal?: boolean;
	focus?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function PopoverPanelFn({
	as: Tag = 'div',
	transition = false,
	static: isStatic = false,
	unmount = true,
	anchor: _anchor,
	portal = false,
	modal = false,
	focus: focusContainment = false,
	children,
	...rest
}: PopoverPanelProps) {
	const { open, close, buttonRef, panelRef, panelId, buttonId } = usePopoverContext('PopoverPanel');

	const trapFocus = modal || focusContainment;

	// Focus trap when modal or focus containment is requested
	useFocusTrap(panelRef, open && trapFocus, { restoreFocus: false });

	// Close on outside click (exclude both button and panel)
	useOutsideClick(
		[buttonRef, panelRef],
		useCallback(() => {
			close();
		}, [close]),
		open
	);

	// Close on escape, restore focus to button
	useEscape(
		useCallback(
			(e: KeyboardEvent) => {
				e.preventDefault();
				close();
			},
			[close]
		),
		open
	);

	// Tab key handling when focus is NOT trapped: Tab closes the popover
	useEffect(() => {
		if (!open || trapFocus) return;

		function handleKeyDown(e: KeyboardEvent) {
			if (e.key === 'Tab') {
				close();
			}
		}

		document.addEventListener('keydown', handleKeyDown, true);
		return () => {
			document.removeEventListener('keydown', handleKeyDown, true);
		};
	}, [open, trapFocus, close]);

	const transitionAttrs = useTransitionAttrs(open, transition);

	const ourProps: Record<string, unknown> = {
		id: panelId,
		ref: panelRef,
		tabIndex: -1,
		'aria-labelledby': buttonId,
		...transitionAttrs,
	};

	if (open) {
		ourProps['data-open'] = '';
	}

	const visible = isStatic || open;
	const features = Features.RenderStrategy | Features.Static;

	const slot = { open, close };

	const inner = render({
		ourProps,
		theirProps: { as: Tag, static: isStatic, unmount, children, ...rest },
		slot,
		defaultTag: 'div',
		features,
		visible,
		name: 'PopoverPanel',
	});

	if (portal) {
		return createElement(Portal, { enabled: true, children: inner });
	}

	return inner;
}

PopoverPanelFn.displayName = 'PopoverPanel';
export const PopoverPanel = PopoverPanelFn;
