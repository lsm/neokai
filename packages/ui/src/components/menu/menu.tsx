import type { RefObject } from 'preact';
import { createContext, createElement, Fragment } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import {
	ActivationTrigger,
	calculateActiveIndex,
	Focus,
} from '../../internal/calculate-active-index.ts';
import { OpenClosedContext, State } from '../../internal/open-closed.ts';
import { Portal } from '../../internal/portal.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useEscape } from '../../internal/use-escape.ts';
import { useId } from '../../internal/use-id.ts';
import { useOutsideClick } from '../../internal/use-outside-click.ts';
import { useTextValue } from '../../internal/use-text-value.ts';
import { useTrackedPointer } from '../../internal/use-tracked-pointer.ts';

// --- Types ---

interface MenuItemData {
	id: string;
	ref: RefObject<HTMLElement | null>;
	readonly disabled: boolean;
	textValue: () => string;
}

interface MenuState {
	open: boolean;
	toggle: () => void;
	close: () => void;
	buttonRef: RefObject<HTMLElement | null>;
	itemsRef: RefObject<HTMLElement | null>;
	buttonId: string;
	itemsId: string;
	items: MenuItemData[];
	registerItem: (item: MenuItemData) => void;
	unregisterItem: (id: string) => void;
	activeItemIndex: number | null;
	setActiveItemIndex: (index: number | null | ((prev: number | null) => number | null)) => void;
	activationTrigger: ActivationTrigger;
	setActivationTrigger: (trigger: ActivationTrigger) => void;
}

// --- Context ---

const MenuContext = createContext<MenuState | null>(null);
MenuContext.displayName = 'MenuContext';

function useMenuContext(component: string): MenuState {
	const ctx = useContext(MenuContext);
	if (ctx === null) {
		throw new Error(`<${component}> must be used within a <Menu>`);
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

// --- Menu (root) ---

interface MenuProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function MenuFn({ as: Tag = Fragment, children, ...rest }: MenuProps) {
	const [open, setOpen] = useState(false);
	const [items, setItems] = useState<MenuItemData[]>([]);
	const [activeItemIndex, setActiveItemIndex] = useState<number | null>(null);
	const [activationTrigger, setActivationTrigger] = useState<ActivationTrigger>(
		ActivationTrigger.Other
	);

	const buttonId = useId();
	const itemsId = useId();
	const buttonRef = useRef<HTMLElement | null>(null);
	const itemsRef = useRef<HTMLElement | null>(null);

	const toggle = useCallback(() => setOpen((v) => !v), []);

	const close = useCallback(() => {
		setOpen(false);
		setActiveItemIndex(null);
	}, []);

	const registerItem = useCallback((item: MenuItemData) => {
		setItems((prev) => {
			// Insert in DOM order
			if (item.ref.current && itemsRef.current) {
				const allItems = Array.from(
					itemsRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]')
				);
				const index = allItems.indexOf(item.ref.current);
				if (index !== -1) {
					const next = [...prev];
					next.splice(index, 0, item);
					return next;
				}
			}
			return [...prev, item];
		});
	}, []);

	const unregisterItem = useCallback((id: string) => {
		setItems((prev) => prev.filter((item) => item.id !== id));
	}, []);

	const ctx: MenuState = {
		open,
		toggle,
		close,
		buttonRef,
		itemsRef,
		buttonId,
		itemsId,
		items,
		registerItem,
		unregisterItem,
		activeItemIndex,
		setActiveItemIndex,
		activationTrigger,
		setActivationTrigger,
	};

	const slot = { open, close };

	return createElement(
		MenuContext.Provider,
		{ value: ctx },
		createElement(
			OpenClosedContext.Provider,
			{ value: open ? State.Open : State.Closed },
			render({
				ourProps: {},
				theirProps: { as: Tag, children, ...rest },
				slot,
				defaultTag: Fragment,
				name: 'Menu',
			})
		)
	);
}

MenuFn.displayName = 'Menu';
export const Menu = MenuFn;

// --- MenuButton ---

interface MenuButtonProps {
	as?: ElementType;
	disabled?: boolean;
	autoFocus?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function MenuButtonFn({
	as: Tag = 'button',
	disabled = false,
	autoFocus = false,
	children,
	...rest
}: MenuButtonProps) {
	const { open, toggle, close, buttonRef, buttonId, itemsId, itemsRef } =
		useMenuContext('MenuButton');

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
			if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				if (!open) {
					toggle();
				}
				// Focus first item after opening
				requestAnimationFrame(() => {
					const el = itemsRef.current;
					if (el) {
						el.focus();
					}
					// Dispatch a synthetic ArrowDown or nothing — the MenuItems keydown handler
					// will handle focusing first/last item. We signal via a custom event.
					el?.dispatchEvent(
						new CustomEvent('menu:openkey', {
							detail: { key: e.key === 'ArrowUp' ? 'ArrowUp' : 'ArrowDown' },
							bubbles: false,
						})
					);
				});
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				if (!open) {
					toggle();
				}
				requestAnimationFrame(() => {
					const el = itemsRef.current;
					if (el) {
						el.focus();
						el.dispatchEvent(
							new CustomEvent('menu:openkey', {
								detail: { key: 'ArrowUp' },
								bubbles: false,
							})
						);
					}
				});
			} else if (e.key === 'Escape') {
				e.preventDefault();
				close();
				requestAnimationFrame(() => {
					buttonRef.current?.focus();
				});
			}
		},
		[disabled, open, toggle, close, itemsRef, buttonRef]
	);

	const ourProps: Record<string, unknown> = {
		id: buttonId,
		ref: buttonRef,
		'aria-haspopup': 'menu',
		'aria-expanded': open,
		'aria-controls': itemsId,
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
		name: 'MenuButton',
	});
}

MenuButtonFn.displayName = 'MenuButton';
export const MenuButton = MenuButtonFn;

// --- MenuItems ---

interface MenuItemsProps {
	as?: ElementType;
	transition?: boolean;
	static?: boolean;
	unmount?: boolean;
	anchor?: string;
	portal?: boolean;
	modal?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function MenuItemsFn({
	as: Tag = 'div',
	transition = false,
	static: isStatic = false,
	unmount = true,
	anchor: _anchor,
	portal = false,
	modal = true,
	children,
	...rest
}: MenuItemsProps) {
	const {
		open,
		close,
		buttonRef,
		itemsRef,
		buttonId,
		itemsId,
		items,
		activeItemIndex,
		setActiveItemIndex,
		setActivationTrigger,
	} = useMenuContext('MenuItems');

	const searchBufferRef = useRef('');
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Close on outside click
	useOutsideClick(
		[buttonRef, itemsRef],
		useCallback(() => {
			close();
		}, [close]),
		open
	);

	// Close on escape
	useEscape(
		useCallback(
			(e: KeyboardEvent) => {
				e.preventDefault();
				close();
				requestAnimationFrame(() => {
					buttonRef.current?.focus();
				});
			},
			[close, buttonRef]
		),
		open
	);

	// Focus the items container when menu opens
	useEffect(() => {
		if (open) {
			requestAnimationFrame(() => {
				itemsRef.current?.focus();
			});
		} else {
			setActiveItemIndex(null);
		}
	}, [open, itemsRef, setActiveItemIndex]);

	// Listen to the custom event dispatched by MenuButton to focus first/last item
	useEffect(() => {
		const el = itemsRef.current;
		if (!el) return;

		function handleOpenKey(e: Event) {
			const key = (e as CustomEvent<{ key: string }>).detail.key;
			if (key === 'ArrowUp') {
				setActiveItemIndex(
					calculateActiveIndex(
						{ focus: Focus.Last },
						{
							resolveItems: () =>
								items.map((item) => ({
									id: item.id,
									dataRef: { current: { disabled: item.disabled } },
								})),
							resolveActiveIndex: () => null,
							resolveId: (item) => item.id,
							resolveDisabled: (item) => item.dataRef.current.disabled,
						}
					)
				);
			} else {
				setActiveItemIndex(
					calculateActiveIndex(
						{ focus: Focus.First },
						{
							resolveItems: () =>
								items.map((item) => ({
									id: item.id,
									dataRef: { current: { disabled: item.disabled } },
								})),
							resolveActiveIndex: () => null,
							resolveId: (item) => item.id,
							resolveDisabled: (item) => item.dataRef.current.disabled,
						}
					)
				);
			}
			setActivationTrigger(ActivationTrigger.Other);
		}

		el.addEventListener('menu:openkey', handleOpenKey);
		return () => el.removeEventListener('menu:openkey', handleOpenKey);
	}, [items, setActiveItemIndex, setActivationTrigger, itemsRef]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			const resolveItems = () =>
				items.map((item) => ({
					id: item.id,
					dataRef: { current: { disabled: item.disabled } },
				}));
			const resolveActiveIndex = () => activeItemIndex;
			const resolveId = (item: { id: string }) => item.id;
			const resolveDisabled = (item: { dataRef: { current: { disabled: boolean } } }) =>
				item.dataRef.current.disabled;

			switch (e.key) {
				case 'ArrowDown': {
					e.preventDefault();
					setActiveItemIndex(
						calculateActiveIndex(
							{ focus: activeItemIndex === null ? Focus.First : Focus.Next },
							{ resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
						)
					);
					setActivationTrigger(ActivationTrigger.Other);
					break;
				}
				case 'ArrowUp': {
					e.preventDefault();
					setActiveItemIndex(
						calculateActiveIndex(
							{ focus: activeItemIndex === null ? Focus.Last : Focus.Previous },
							{ resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
						)
					);
					setActivationTrigger(ActivationTrigger.Other);
					break;
				}
				case 'Home':
				case 'PageUp': {
					e.preventDefault();
					setActiveItemIndex(
						calculateActiveIndex(
							{ focus: Focus.First },
							{ resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
						)
					);
					setActivationTrigger(ActivationTrigger.Other);
					break;
				}
				case 'End':
				case 'PageDown': {
					e.preventDefault();
					setActiveItemIndex(
						calculateActiveIndex(
							{ focus: Focus.Last },
							{ resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
						)
					);
					setActivationTrigger(ActivationTrigger.Other);
					break;
				}
				case 'Enter':
				case ' ': {
					e.preventDefault();
					if (activeItemIndex !== null) {
						const item = items[activeItemIndex];
						if (item && !item.disabled) {
							item.ref.current?.click();
						}
					}
					close();
					requestAnimationFrame(() => {
						buttonRef.current?.focus();
					});
					break;
				}
				case 'Tab': {
					e.preventDefault();
					close();
					break;
				}
				default: {
					// Typeahead: single printable character
					if (e.key.length === 1 && e.key.match(/\S/)) {
						e.preventDefault();
						searchBufferRef.current += e.key.toLowerCase();
						if (searchTimerRef.current !== null) {
							clearTimeout(searchTimerRef.current);
						}
						searchTimerRef.current = setTimeout(() => {
							searchBufferRef.current = '';
							searchTimerRef.current = null;
						}, 350);

						const query = searchBufferRef.current;
						const matchIndex = items.findIndex((item, index) => {
							if (item.disabled) return false;
							// Start search after current active item
							if (activeItemIndex !== null && index <= activeItemIndex) return false;
							return item.textValue().startsWith(query);
						});

						if (matchIndex !== -1) {
							setActiveItemIndex(matchIndex);
							setActivationTrigger(ActivationTrigger.Other);
						} else {
							// Wrap around from beginning
							const wrapIndex = items.findIndex((item) => {
								if (item.disabled) return false;
								return item.textValue().startsWith(query);
							});
							if (wrapIndex !== -1) {
								setActiveItemIndex(wrapIndex);
								setActivationTrigger(ActivationTrigger.Other);
							}
						}
					}
					break;
				}
			}
		},
		[items, activeItemIndex, setActiveItemIndex, setActivationTrigger, close, buttonRef]
	);

	const transitionAttrs = useTransitionAttrs(open, transition);

	const activeItemId =
		activeItemIndex !== null && items[activeItemIndex] ? items[activeItemIndex].id : undefined;

	const ourProps: Record<string, unknown> = {
		id: itemsId,
		ref: itemsRef,
		role: 'menu',
		'aria-activedescendant': activeItemId,
		'aria-labelledby': buttonId,
		tabIndex: 0,
		onKeyDown: handleKeyDown,
		...transitionAttrs,
	};

	void modal;
	const visible = isStatic || open;
	const features = Features.RenderStrategy | Features.Static;

	const slot = { open };

	const inner = render({
		ourProps,
		theirProps: { as: Tag, static: isStatic, unmount, children, ...rest },
		slot,
		defaultTag: 'div',
		features,
		visible,
		name: 'MenuItems',
	});

	if (portal) {
		return createElement(Portal, { enabled: true, children: inner });
	}

	return inner;
}

MenuItemsFn.displayName = 'MenuItems';
export const MenuItems = MenuItemsFn;

// --- MenuItem ---

interface MenuItemProps {
	as?: ElementType;
	disabled?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function MenuItemFn({ as: Tag = Fragment, disabled = false, children, ...rest }: MenuItemProps) {
	const {
		close,
		items,
		registerItem,
		unregisterItem,
		activeItemIndex,
		setActiveItemIndex,
		setActivationTrigger,
	} = useMenuContext('MenuItem');

	const id = useId();
	const ref = useRef<HTMLElement | null>(null);
	const disabledRef = useRef(disabled);
	disabledRef.current = disabled;
	const getTextValue = useTextValue(ref);
	const pointer = useTrackedPointer();

	const [hover, setHover] = useState(false);
	const [focus, setFocus] = useState(false);

	// Compute active state
	const activeItem = activeItemIndex !== null ? items[activeItemIndex] : null;
	const isActive = activeItem ? activeItem.id === id : false;

	// Register/unregister with menu context on mount/unmount
	useEffect(() => {
		const itemData: MenuItemData = {
			id,
			ref,
			get disabled() {
				return disabledRef.current;
			},
			textValue: getTextValue,
		};
		registerItem(itemData);
		return () => unregisterItem(id);
		// Only run on mount/unmount
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id]);

	const handleClick = useCallback(
		(e: MouseEvent) => {
			if (disabled) {
				e.preventDefault();
				return;
			}
			close();
		},
		[disabled, close]
	);

	const handlePointerMove = useCallback(
		(e: PointerEvent) => {
			pointer.update(e);
			if (!pointer.wasMoved(e)) return;
			if (disabled) return;
			setHover(true);
			// Find this item's index and set active
			setActiveItemIndex((currentIndex) => {
				const idx = items.findIndex((item) => item.id === id);
				if (idx === -1) return currentIndex;
				return idx;
			});
			setActivationTrigger(ActivationTrigger.Pointer);
		},
		[disabled, id, items, pointer, setActiveItemIndex, setActivationTrigger]
	);

	const handlePointerLeave = useCallback(
		(e: PointerEvent) => {
			pointer.update(e);
			setHover(false);
			setActiveItemIndex((currentIndex) => {
				const idx = items.findIndex((item) => item.id === id);
				if (idx !== -1 && currentIndex === idx) return null;
				return currentIndex;
			});
		},
		[id, items, pointer, setActiveItemIndex]
	);

	const ourProps: Record<string, unknown> = {
		id,
		ref,
		role: 'menuitem',
		tabIndex: -1,
		'aria-disabled': disabled || undefined,
		onClick: handleClick,
		onPointerMove: handlePointerMove,
		onPointerLeave: handlePointerLeave,
		onFocus: () => setFocus(true),
		onBlur: () => setFocus(false),
	};

	const slot = {
		active: isActive,
		disabled,
		close,
		focus,
		hover,
	};

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: Fragment,
		name: 'MenuItem',
	});
}

MenuItemFn.displayName = 'MenuItem';
export const MenuItem = MenuItemFn;

// --- MenuSection ---

interface MenuSectionProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function MenuSectionFn({ as: Tag = 'div', children, ...rest }: MenuSectionProps) {
	const slot = {};

	return render({
		ourProps: {},
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'div',
		name: 'MenuSection',
	});
}

MenuSectionFn.displayName = 'MenuSection';
export const MenuSection = MenuSectionFn;

// --- MenuHeading ---

interface MenuHeadingProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function MenuHeadingFn({ as: Tag = 'header', children, ...rest }: MenuHeadingProps) {
	const slot = {};

	return render({
		ourProps: { role: 'presentation' },
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'header',
		name: 'MenuHeading',
	});
}

MenuHeadingFn.displayName = 'MenuHeading';
export const MenuHeading = MenuHeadingFn;

// --- MenuSeparator ---

interface MenuSeparatorProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function MenuSeparatorFn({ as: Tag = 'div', children, ...rest }: MenuSeparatorProps) {
	const slot = {};

	return render({
		ourProps: { role: 'separator' },
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'div',
		name: 'MenuSeparator',
	});
}

MenuSeparatorFn.displayName = 'MenuSeparator';
export const MenuSeparator = MenuSeparatorFn;
