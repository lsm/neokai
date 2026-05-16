import { useEffect, useState } from 'preact/hooks';
import type { Session, SessionFeatures } from '@neokai/shared';
import { DEFAULT_LOBBY_FEATURES, DEFAULT_WORKER_FEATURES } from '@neokai/shared';
import { GitPanel } from '../components/GitPanel.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import { sessionStore } from '../lib/session-store.ts';
import { type RightPanelTarget, rightPanelTargetSignal } from '../lib/signals.ts';
import { cn } from '../lib/utils.ts';

const PANEL_WIDTH = 'w-80';
const TRANSITION_MS = 200;

function sessionFeatures(session: Session | null, sessionId: string): SessionFeatures {
	if (session?.config?.features) return session.config.features;
	if (sessionId.startsWith('lobby:')) return DEFAULT_LOBBY_FEATURES;
	if (sessionId.startsWith('space:chat:')) return { ...DEFAULT_WORKER_FEATURES, archive: false };
	return DEFAULT_WORKER_FEATURES;
}

export function RightPanelToggle() {
	const activeSessionId = sessionStore.activeSessionId.value;
	const session = sessionStore.sessionInfo.value;
	const activeSession = session?.id === activeSessionId ? session : null;
	const target = rightPanelTargetSignal.value;
	const worktreeEnabled = activeSessionId
		? sessionFeatures(activeSession, activeSessionId).worktree
		: false;
	const rightPanelOpen = target !== null;

	useEffect(() => {
		if (!target) return;
		if (!activeSessionId || !worktreeEnabled) {
			rightPanelTargetSignal.value = null;
			return;
		}
		if (target.type === 'git' && target.sessionId !== activeSessionId) {
			rightPanelTargetSignal.value = { type: 'git', sessionId: activeSessionId };
		}
	}, [activeSessionId, target, worktreeEnabled]);

	if (!activeSessionId || !worktreeEnabled) return null;

	const handleToggle = () => {
		rightPanelTargetSignal.value = rightPanelOpen
			? null
			: { type: 'git', sessionId: activeSessionId };
	};

	return (
		<IconButton
			title={rightPanelOpen ? 'Hide right panel' : 'Show right panel'}
			onClick={handleToggle}
			class={cn(
				'absolute right-3 top-2 z-40 hidden bg-dark-900/80 backdrop-blur lg:inline-flex',
				rightPanelOpen && 'bg-white/10 text-gray-100 hover:bg-white/10'
			)}
		>
			<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={1.8}
					d="M4.75 5.75A2 2 0 016.75 3.75h10.5a2 2 0 012 2v12.5a2 2 0 01-2 2H6.75a2 2 0 01-2-2V5.75zM14.5 4v16"
				/>
			</svg>
		</IconButton>
	);
}

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
				{renderedTarget?.type === 'git' && <GitPanel sessionId={renderedTarget.sessionId} />}
			</div>
		</div>
	);
}
