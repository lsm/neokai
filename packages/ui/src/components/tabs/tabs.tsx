import { createContext, createElement } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { focusElement } from '../../internal/focus-management.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useControllable } from '../../internal/use-controllable.ts';
import { useId } from '../../internal/use-id.ts';

// --- Context types ---

interface TabData {
	id: string;
	ref: { current: HTMLElement | null };
	disabled: boolean;
}

interface PanelData {
	id: string;
	ref: { current: HTMLElement | null };
}

interface TabGroupState {
	selectedIndex: number;
	setSelectedIndex: (index: number) => void;
	tabs: TabData[];
	panels: PanelData[];
	registerTab: (tab: TabData) => () => void;
	registerPanel: (panel: PanelData) => () => void;
	manual: boolean;
	vertical: boolean;
}

const TabGroupContext = createContext<TabGroupState | null>(null);
TabGroupContext.displayName = 'TabGroupContext';

function useTabGroupContext(component: string): TabGroupState {
	const ctx = useContext(TabGroupContext);
	if (ctx === null) {
		throw new Error(`<${component}> must be used within a <TabGroup>`);
	}
	return ctx;
}

// Sort tab/panel data arrays by DOM order
function sortByDomOrder<T extends { ref: { current: HTMLElement | null } }>(items: T[]): T[] {
	return items.slice().sort((a, b) => {
		if (!a.ref.current || !b.ref.current) return 0;
		const position = a.ref.current.compareDocumentPosition(b.ref.current);
		if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
		if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
		return 0;
	});
}

// --- TabGroup ---

interface TabGroupProps {
	as?: ElementType;
	selectedIndex?: number;
	defaultIndex?: number;
	onChange?: (index: number) => void;
	manual?: boolean;
	vertical?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function TabGroupFn({
	as: Tag = 'div',
	selectedIndex: controlledIndex,
	defaultIndex = 0,
	onChange,
	manual = false,
	vertical = false,
	children,
	...rest
}: TabGroupProps) {
	const [selectedIndex, setSelectedIndex] = useControllable(
		controlledIndex,
		onChange,
		defaultIndex
	);

	const [tabs, setTabs] = useState<TabData[]>([]);
	const [panels, setPanels] = useState<PanelData[]>([]);

	const registerTab = useCallback((tab: TabData) => {
		setTabs((prev) => {
			if (prev.find((t) => t.id === tab.id)) return prev;
			const next = [...prev, tab];
			return sortByDomOrder(next);
		});
		return () => {
			setTabs((prev) => prev.filter((t) => t.id !== tab.id));
		};
	}, []);

	const registerPanel = useCallback((panel: PanelData) => {
		setPanels((prev) => {
			if (prev.find((p) => p.id === panel.id)) return prev;
			const next = [...prev, panel];
			return sortByDomOrder(next);
		});
		return () => {
			setPanels((prev) => prev.filter((p) => p.id !== panel.id));
		};
	}, []);

	const ctx: TabGroupState = {
		selectedIndex,
		setSelectedIndex,
		tabs,
		panels,
		registerTab,
		registerPanel,
		manual,
		vertical,
	};

	const slot = { selectedIndex };

	return createElement(
		TabGroupContext.Provider,
		{ value: ctx },
		render({
			ourProps: {},
			theirProps: { as: Tag, children, ...rest },
			slot,
			defaultTag: 'div',
			name: 'TabGroup',
		})
	);
}

TabGroupFn.displayName = 'TabGroup';
export const TabGroup = TabGroupFn;

// --- TabList ---

interface TabListProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function TabListFn({ as: Tag = 'div', children, ...rest }: TabListProps) {
	const { selectedIndex, vertical } = useTabGroupContext('TabList');

	const slot = { selectedIndex };

	const ourProps: Record<string, unknown> = {
		role: 'tablist',
		'aria-orientation': vertical ? 'vertical' : 'horizontal',
	};

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'div',
		name: 'TabList',
	});
}

TabListFn.displayName = 'TabList';
export const TabList = TabListFn;

// --- Tab ---

interface TabProps {
	as?: ElementType;
	disabled?: boolean;
	autoFocus?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function TabFn({
	as: Tag = 'button',
	disabled = false,
	autoFocus = false,
	children,
	...rest
}: TabProps) {
	const { selectedIndex, setSelectedIndex, tabs, panels, manual, vertical } =
		useTabGroupContext('Tab');

	const id = useId();
	const ref = useRef<HTMLElement | null>(null);

	const [hover, setHover] = useState(false);
	const [focus, setFocus] = useState(false);
	const [active, setActive] = useState(false);

	const { registerTab } = useTabGroupContext('Tab');

	// Register/unregister this tab
	useEffect(() => {
		const tabData: TabData = { id, ref, disabled };
		return registerTab(tabData);
	}, [id, registerTab, disabled]);

	// Derive index of this tab from the ordered tabs array
	const myIndex = tabs.findIndex((t) => t.id === id);
	const selected = myIndex !== -1 && myIndex === selectedIndex;
	const panelId = panels[myIndex]?.id;

	const getNextNonDisabledIndex = useCallback(
		(from: number, direction: 1 | -1): number => {
			const count = tabs.length;
			for (let i = 1; i <= count; i++) {
				const idx = (from + direction * i + count) % count;
				if (!tabs[idx]?.disabled) return idx;
			}
			return from;
		},
		[tabs]
	);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (myIndex === -1) return;

			const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';
			const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';

			let targetIndex: number | null = null;
			const activate = !manual;

			switch (e.key) {
				case nextKey: {
					e.preventDefault();
					targetIndex = getNextNonDisabledIndex(myIndex, 1);
					break;
				}
				case prevKey: {
					e.preventDefault();
					targetIndex = getNextNonDisabledIndex(myIndex, -1);
					break;
				}
				case 'Home': {
					e.preventDefault();
					targetIndex = getNextNonDisabledIndex(-1, 1);
					break;
				}
				case 'End': {
					e.preventDefault();
					targetIndex = getNextNonDisabledIndex(tabs.length, -1);
					break;
				}
				case 'Enter':
				case ' ': {
					e.preventDefault();
					if (manual && !disabled) {
						setSelectedIndex(myIndex);
					}
					return;
				}
				default:
					return;
			}

			if (targetIndex === null) return;

			const targetTab = tabs[targetIndex];
			if (!targetTab) return;

			focusElement(targetTab.ref.current);
			if (activate && !targetTab.disabled) {
				setSelectedIndex(targetIndex);
			}
		},
		[myIndex, vertical, manual, disabled, tabs, getNextNonDisabledIndex, setSelectedIndex]
	);

	const handleClick = useCallback(
		(e: MouseEvent) => {
			if (disabled) return;
			e.preventDefault();
			if (myIndex !== -1) {
				setSelectedIndex(myIndex);
			}
		},
		[disabled, myIndex, setSelectedIndex]
	);

	const handleFocus = useCallback(() => {
		setFocus(true);
		// In automatic mode, focusing a tab selects it
		if (!manual && !disabled && myIndex !== -1) {
			setSelectedIndex(myIndex);
		}
	}, [manual, disabled, myIndex, setSelectedIndex]);

	const ourProps: Record<string, unknown> = {
		id,
		ref,
		role: 'tab',
		'aria-selected': selected,
		'aria-controls': panelId,
		tabIndex: selected ? 0 : -1,
		autoFocus,
		disabled: disabled || undefined,
		onClick: handleClick,
		onKeyDown: handleKeyDown,
		onMouseEnter: () => setHover(true),
		onMouseLeave: () => setHover(false),
		onFocus: handleFocus,
		onBlur: () => setFocus(false),
		onMouseDown: () => setActive(true),
		onMouseUp: () => setActive(false),
	};

	const slot = { selected, hover, focus, active, autofocus: autoFocus, disabled };

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'button',
		name: 'Tab',
	});
}

TabFn.displayName = 'Tab';
export const Tab = TabFn;

// --- TabPanels ---

interface TabPanelsProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function TabPanelsFn({ as: Tag = 'div', children, ...rest }: TabPanelsProps) {
	const { selectedIndex } = useTabGroupContext('TabPanels');

	const slot = { selectedIndex };

	return render({
		ourProps: {},
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'div',
		name: 'TabPanels',
	});
}

TabPanelsFn.displayName = 'TabPanels';
export const TabPanels = TabPanelsFn;

// --- TabPanel ---

interface TabPanelProps {
	as?: ElementType;
	static?: boolean;
	unmount?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function TabPanelFn({
	as: Tag = 'div',
	static: isStatic = false,
	unmount = true,
	children,
	...rest
}: TabPanelProps) {
	const { selectedIndex, panels, tabs, registerPanel } = useTabGroupContext('TabPanel');

	const id = useId();
	const ref = useRef<HTMLElement | null>(null);

	const [focus, setFocus] = useState(false);

	// Register/unregister this panel
	useEffect(() => {
		const panelData: PanelData = { id, ref };
		return registerPanel(panelData);
	}, [id, registerPanel]);

	// Derive index of this panel from the ordered panels array
	const myIndex = panels.findIndex((p) => p.id === id);
	const selected = myIndex !== -1 && myIndex === selectedIndex;
	const tabId = tabs[myIndex]?.id;

	const ourProps: Record<string, unknown> = {
		id,
		ref,
		role: 'tabpanel',
		'aria-labelledby': tabId,
		tabIndex: selected ? 0 : undefined,
		onFocus: () => setFocus(true),
		onBlur: () => setFocus(false),
	};

	const slot = { selected, focus };

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
		visible: isStatic || selected,
		name: 'TabPanel',
	});
}

TabPanelFn.displayName = 'TabPanel';
export const TabPanel = TabPanelFn;
