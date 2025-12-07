import { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export type TransitionType = 'fade' | 'slide' | 'scale' | 'slideAndFade';

export interface TransitionProps {
	show: boolean;
	children: ComponentChildren;
	type?: TransitionType;
	duration?: number;
	onExited?: () => void;
}

export function Transition({
	show,
	children,
	type = 'fade',
	duration = 200,
	onExited,
}: TransitionProps) {
	const [shouldRender, setShouldRender] = useState(show);
	const [isVisible, setIsVisible] = useState(false);

	useEffect(() => {
		if (show) {
			setShouldRender(true);
			// Small delay to trigger animation
			setTimeout(() => setIsVisible(true), 10);
		} else {
			setIsVisible(false);
			// Wait for animation to complete before unmounting
			const timer = setTimeout(() => {
				setShouldRender(false);
				onExited?.();
			}, duration);
			return () => clearTimeout(timer);
		}
	}, [show, duration, onExited]);

	if (!shouldRender) return null;

	const getTransitionClasses = () => {
		const baseClass = `transition-all duration-${duration}`;

		switch (type) {
			case 'fade':
				return `${baseClass} ${isVisible ? 'opacity-100' : 'opacity-0'}`;
			case 'slide':
				return `${baseClass} ${
					isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
				}`;
			case 'scale':
				return `${baseClass} ${isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`;
			case 'slideAndFade':
				return `${baseClass} ${
					isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
				}`;
			default:
				return baseClass;
		}
	};

	return <div class={getTransitionClasses()}>{children}</div>;
}
