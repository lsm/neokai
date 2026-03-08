import { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useMemo } from 'preact/hooks';

interface PortalProps {
	children: ComponentChildren;
	into?: string | HTMLElement;
}

/**
 * Portal component for Preact 10+
 *
 * Renders children into a DOM node outside the parent component's DOM hierarchy.
 * Uses createPortal to keep children in the same Preact component tree,
 * preserving hooks, context, and event handling.
 *
 * @example
 * <Portal into="body">
 *   <div>Rendered into document.body</div>
 * </Portal>
 */
export function Portal({ children, into = 'body' }: PortalProps) {
	const container = useMemo(() => {
		const el = document.createElement('div');
		el.setAttribute('data-portal', 'true');
		return el;
	}, []);

	useEffect(() => {
		const target = typeof into === 'string' ? document.querySelector(into) : into;
		if (target) {
			target.appendChild(container);
		}
		return () => {
			container.remove();
		};
	}, [into, container]);

	return createPortal(<>{children}</>, container);
}
