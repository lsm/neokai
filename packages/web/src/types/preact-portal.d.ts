declare module 'preact-portal' {
	import { ComponentChildren, VNode } from 'preact';

	interface PortalProps {
		into?: string | HTMLElement;
		children?: ComponentChildren;
	}

	export default function Portal(props: PortalProps): VNode<unknown>;
}
