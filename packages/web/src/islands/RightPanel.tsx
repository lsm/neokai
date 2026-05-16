import { useEffect, useState } from 'preact/hooks';
import { GitPanel } from '../components/GitPanel.tsx';
import { type RightPanelTarget, rightPanelTargetSignal } from '../lib/signals.ts';
import { cn } from '../lib/utils.ts';

const PANEL_WIDTH = 'w-80';
const TRANSITION_MS = 200;

export function RightPanel() {
	const target = rightPanelTargetSignal.value;
	const [renderedTarget, setRenderedTarget] = useState<RightPanelTarget | null>(target);
	const [open, setOpen] = useState(target !== null);

	useEffect(() => {
		let frame = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;

		if (target) {
			setRenderedTarget(target);
			frame = requestAnimationFrame(() => setOpen(true));
		} else {
			setOpen(false);
			timer = setTimeout(() => setRenderedTarget(null), TRANSITION_MS);
		}

		return () => {
			cancelAnimationFrame(frame);
			if (timer) clearTimeout(timer);
		};
	}, [target]);

	return (
		<div
			class={cn(
				'hidden h-full flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out lg:block',
				open ? PANEL_WIDTH : 'w-0'
			)}
		>
			<div
				class={cn(
					'h-full w-80 transition-transform duration-200 ease-out',
					open ? 'translate-x-0' : 'translate-x-full'
				)}
			>
				{renderedTarget?.type === 'git' && (
					<GitPanel
						sessionId={renderedTarget.sessionId}
						onClose={() => (rightPanelTargetSignal.value = null)}
					/>
				)}
			</div>
		</div>
	);
}
