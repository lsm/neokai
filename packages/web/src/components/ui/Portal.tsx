import { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { render } from 'preact';

interface PortalProps {
	children: ComponentChildren;
	into?: string | HTMLElement;
}

/**
 * Portal component for Preact 10+
 *
 * Renders children into a DOM node outside the parent component's DOM hierarchy.
 * Compatible with Preact 10.x (unlike preact-portal which uses deprecated APIs).
 *
 * @example
 * <Portal into="body">
 *   <div>Rendered into document.body</div>
 * </Portal>
 */
export function Portal({ children, into = 'body' }: PortalProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		// Create a container element
		const container = document.createElement('div');
		container.setAttribute('data-portal', 'true');
		containerRef.current = container;

		// Find target element
		const target = typeof into === 'string' ? document.querySelector(into) : into;

		if (target) {
			target.appendChild(container);
			setMounted(true);
		}

		// Cleanup on unmount
		return () => {
			if (containerRef.current?.parentNode) {
				// Unmount any rendered content first
				render(null, containerRef.current);
				containerRef.current.parentNode.removeChild(containerRef.current);
			}
			containerRef.current = null;
		};
	}, [into]);

	// Render children into the container
	useEffect(() => {
		if (mounted && containerRef.current) {
			render(<>{children}</>, containerRef.current);
		}
	}, [mounted, children]);

	// Portal renders nothing in its original location
	return null;
}

export default Portal;
