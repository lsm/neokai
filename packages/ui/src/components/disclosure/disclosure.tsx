import { createContext, createElement, Fragment } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { OpenClosedContext, State } from '../../internal/open-closed.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useId } from '../../internal/use-id.ts';

interface DisclosureState {
	open: boolean;
	toggle: () => void;
	close: (focusRef?: { current: HTMLElement | null }) => void;
	buttonId: string;
	panelId: string;
	buttonRef: { current: HTMLElement | null };
	panelRef: { current: HTMLElement | null };
}

const DisclosureContext = createContext<DisclosureState | null>(null);
DisclosureContext.displayName = 'DisclosureContext';

function useDisclosureContext(component: string): DisclosureState {
	const ctx = useContext(DisclosureContext);
	if (ctx === null) {
		throw new Error(`<${component}> must be used within a <Disclosure>`);
	}
	return ctx;
}

// --- Disclosure (root) ---

interface DisclosureProps {
	as?: ElementType;
	defaultOpen?: boolean;
	children?: unknown;
}

function DisclosureFn({
	as: Tag = Fragment,
	defaultOpen = false,
	children,
	...rest
}: DisclosureProps) {
	const [open, setOpen] = useState(defaultOpen);
	const buttonId = useId();
	const panelId = useId();
	const buttonRef = useRef<HTMLElement | null>(null);
	const panelRef = useRef<HTMLElement | null>(null);

	const toggle = useCallback(() => setOpen((v) => !v), []);

	const close = useCallback((focusRef?: { current: HTMLElement | null }) => {
		setOpen(false);
		const target = focusRef?.current ?? buttonRef.current;
		if (target) {
			target.focus();
		}
	}, []);

	const ctx: DisclosureState = { open, toggle, close, buttonId, panelId, buttonRef, panelRef };

	const slot = { open, close };

	const ourProps = {};
	const theirProps = { as: Tag, ...rest, children };

	return createElement(
		DisclosureContext.Provider,
		{ value: ctx },
		createElement(
			OpenClosedContext.Provider,
			{ value: open ? State.Open : State.Closed },
			render({
				ourProps,
				theirProps,
				slot,
				defaultTag: Fragment,
				name: 'Disclosure',
			})
		)
	);
}

DisclosureFn.displayName = 'Disclosure';
export const Disclosure = DisclosureFn;

// --- DisclosureButton ---

interface DisclosureButtonProps {
	as?: ElementType;
	autoFocus?: boolean;
	disabled?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function DisclosureButtonFn({
	as: Tag = 'button',
	autoFocus = false,
	disabled = false,
	children,
	...rest
}: DisclosureButtonProps) {
	const { open, toggle, panelId, buttonId, buttonRef } = useDisclosureContext('DisclosureButton');

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
		name: 'DisclosureButton',
	});
}

DisclosureButtonFn.displayName = 'DisclosureButton';
export const DisclosureButton = DisclosureButtonFn;

// --- DisclosurePanel ---

interface DisclosurePanelProps {
	as?: ElementType;
	transition?: boolean;
	static?: boolean;
	unmount?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function DisclosurePanelFn({
	as: Tag = 'div',
	transition = false,
	static: isStatic = false,
	unmount = true,
	children,
	...rest
}: DisclosurePanelProps) {
	const { open, close, panelId, panelRef } = useDisclosureContext('DisclosurePanel');

	// Transition data attribute state
	const [transitionAttrs, setTransitionAttrs] = useState<{
		'data-transition'?: '';
		'data-enter'?: '';
		'data-leave'?: '';
		'data-closed'?: '';
	}>({});

	const prevOpenRef = useRef(open);

	useEffect(() => {
		if (!transition) {
			setTransitionAttrs({});
			return;
		}

		const prev = prevOpenRef.current;
		prevOpenRef.current = open;

		if (open && !prev) {
			// Opening: data-enter + data-transition for one frame, then remove
			setTransitionAttrs({ 'data-transition': '', 'data-enter': '' });
			const raf = requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setTransitionAttrs({});
				});
			});
			return () => cancelAnimationFrame(raf);
		}

		if (!open && prev) {
			// Closing: data-leave + data-transition + data-closed, then clear
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

	const slot = { open, close };

	const ourProps: Record<string, unknown> = {
		id: panelId,
		ref: panelRef,
		...transitionAttrs,
	};

	const visible = isStatic || open;

	const features = Features.RenderStrategy | Features.Static;

	return render({
		ourProps,
		theirProps: {
			as: Tag,
			static: isStatic,
			unmount,
			children,
			...rest,
		},
		slot,
		defaultTag: 'div',
		features,
		visible,
		name: 'DisclosurePanel',
	});
}

DisclosurePanelFn.displayName = 'DisclosurePanel';
export const DisclosurePanel = DisclosurePanelFn;
