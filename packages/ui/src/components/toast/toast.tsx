import { createContext, createElement } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { Portal } from '../../internal/portal.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { useId } from '../../internal/use-id.ts';
import { Transition } from '../transition/transition.tsx';

// --- Toast store (module-level) ---

export interface ToastOptions {
	id?: string;
	title?: string;
	description?: string;
	duration?: number;
}

export interface ToastItem extends ToastOptions {
	id: string;
}

type ToastListener = (toasts: ToastItem[]) => void;

let toastItems: ToastItem[] = [];
const listeners = new Set<ToastListener>();

let idCounter = 0;

function generateToastId(): string {
	return `toast-${++idCounter}`;
}

function notify(): void {
	for (const listener of listeners) {
		listener([...toastItems]);
	}
}

function addToast(options: ToastOptions): string {
	const id = options.id ?? generateToastId();
	toastItems = [...toastItems.filter((t) => t.id !== id), { ...options, id }];
	notify();
	return id;
}

function removeToast(id: string): void {
	toastItems = toastItems.filter((t) => t.id !== id);
	notify();
}

function subscribe(listener: ToastListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

// --- useToast hook ---

export function useToast(): {
	toast: (options: ToastOptions) => string;
	dismiss: (id: string) => void;
	toasts: ToastItem[];
} {
	const [toasts, setToasts] = useState<ToastItem[]>([...toastItems]);

	useEffect(() => {
		return subscribe(setToasts);
	}, []);

	const toast = useCallback((options: ToastOptions) => addToast(options), []);
	const dismiss = useCallback((id: string) => removeToast(id), []);

	return { toast, dismiss, toasts };
}

// --- Toast context ---

interface ToastState {
	id: string;
	open: boolean;
	dismiss: () => void;
	titleId: string | null;
	setTitleId: (id: string | null) => void;
	descriptionId: string | null;
	setDescriptionId: (id: string | null) => void;
}

const ToastContext = createContext<ToastState | null>(null);
ToastContext.displayName = 'ToastContext';

function useToastContext(component: string): ToastState {
	const ctx = useContext(ToastContext);
	if (ctx === null) {
		throw new Error(`<${component}> must be used within a <Toast>`);
	}
	return ctx;
}

// --- Toast (individual notification) ---

interface ToastProps {
	show: boolean;
	duration?: number;
	afterLeave?: () => void;
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function ToastFn({
	show,
	duration = 5000,
	afterLeave,
	as: Tag = 'div',
	children,
	...rest
}: ToastProps) {
	const id = useId();
	const [titleId, setTitleId] = useState<string | null>(null);
	const [descriptionId, setDescriptionId] = useState<string | null>(null);
	const [open, setOpen] = useState(show);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Sync open state with show prop
	useEffect(() => {
		setOpen(show);
	}, [show]);

	// Auto-dismiss timer
	useEffect(() => {
		if (!open || duration === 0) return;

		timerRef.current = setTimeout(() => {
			setOpen(false);
		}, duration);

		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, [open, duration]);

	const dismiss = useCallback(() => {
		setOpen(false);
	}, []);

	const ctx: ToastState = {
		id,
		open,
		dismiss,
		titleId,
		setTitleId,
		descriptionId,
		setDescriptionId,
	};

	const slot = { open };

	const ourProps: Record<string, unknown> = {
		id,
		role: 'status',
		'aria-atomic': 'true',
		'aria-labelledby': titleId ?? undefined,
		'aria-describedby': descriptionId ?? undefined,
	};

	const inner = render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'div',
		name: 'Toast',
	});

	return createElement(
		ToastContext.Provider,
		{ value: ctx },
		createElement(Transition, { show: open, appear: true, afterLeave, as: 'div' }, inner)
	);
}

ToastFn.displayName = 'Toast';
export const Toast = ToastFn;

// --- ToastTitle ---

interface ToastTitleProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function ToastTitleFn({ as: Tag = 'p', children, ...rest }: ToastTitleProps) {
	const { open, setTitleId } = useToastContext('ToastTitle');
	const id = useId();

	useEffect(() => {
		setTitleId(id);
		return () => setTitleId(null);
	}, [id, setTitleId]);

	const slot = { open };

	const ourProps: Record<string, unknown> = {
		id,
	};

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'p',
		name: 'ToastTitle',
	});
}

ToastTitleFn.displayName = 'ToastTitle';
export const ToastTitle = ToastTitleFn;

// --- ToastDescription ---

interface ToastDescriptionProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function ToastDescriptionFn({ as: Tag = 'p', children, ...rest }: ToastDescriptionProps) {
	const { open, setDescriptionId } = useToastContext('ToastDescription');
	const id = useId();

	useEffect(() => {
		setDescriptionId(id);
		return () => setDescriptionId(null);
	}, [id, setDescriptionId]);

	const slot = { open };

	const ourProps: Record<string, unknown> = {
		id,
	};

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'p',
		name: 'ToastDescription',
	});
}

ToastDescriptionFn.displayName = 'ToastDescription';
export const ToastDescription = ToastDescriptionFn;

// --- ToastAction ---

interface ToastActionProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function ToastActionFn({ as: Tag = 'button', children, ...rest }: ToastActionProps) {
	const { open } = useToastContext('ToastAction');

	const [hover, setHover] = useState(false);
	const [focus, setFocus] = useState(false);
	const [active, setActive] = useState(false);

	const slot = { open, hover, focus, active };

	const ourProps: Record<string, unknown> = {
		type: 'button',
		onMouseEnter: () => setHover(true),
		onMouseLeave: () => setHover(false),
		onFocus: () => setFocus(true),
		onBlur: () => setFocus(false),
		onMouseDown: () => setActive(true),
		onMouseUp: () => setActive(false),
	};

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'button',
		name: 'ToastAction',
	});
}

ToastActionFn.displayName = 'ToastAction';
export const ToastAction = ToastActionFn;

// --- Toaster (container) ---

type ToasterPosition =
	| 'top-right'
	| 'top-left'
	| 'bottom-right'
	| 'bottom-left'
	| 'top-center'
	| 'bottom-center';

interface ToasterProps {
	position?: ToasterPosition;
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function ToasterFn({
	position = 'bottom-right',
	as: Tag = 'div',
	children,
	...rest
}: ToasterProps) {
	const { toasts, dismiss } = useToast();

	const slot = { position };

	const ourProps: Record<string, unknown> = {
		role: 'region',
		'aria-live': 'polite',
		'aria-label': 'Notifications',
		'data-position': position,
	};

	// Render user-provided children if any, otherwise render managed toasts
	const content =
		children ??
		toasts.map((item) =>
			createElement(
				Toast,
				{
					key: item.id,
					show: true,
					duration: item.duration,
					afterLeave: () => dismiss(item.id),
				},
				item.title && createElement(ToastTitle, null, item.title),
				item.description && createElement(ToastDescription, null, item.description)
			)
		);

	const inner = render({
		ourProps,
		theirProps: { as: Tag, children: content, ...rest },
		slot,
		defaultTag: 'div',
		name: 'Toaster',
	});

	return createElement(Portal, { enabled: true, children: inner });
}

ToasterFn.displayName = 'Toaster';
export const Toaster = ToasterFn;
