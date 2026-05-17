import { useEffect, useState } from 'preact/hooks';
import type { Session, SessionFeatures } from '@neokai/shared';
import { DEFAULT_LOBBY_FEATURES, DEFAULT_WORKER_FEATURES } from '@neokai/shared';
import { GitPanel } from '../components/GitPanel.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import { sessionStore } from '../lib/session-store.ts';
import { type RightPanelTarget, rightPanelTargetSignal } from '../lib/signals.ts';
import { cn } from '../lib/utils.ts';

const TRANSITION_MS = 200;
const DEFAULT_PANEL_WIDTH = 320;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 640;
const PANEL_WIDTH_STORAGE_KEY = 'neokai_right_panel_width';

function getMaxPanelWidth(): number {
	if (typeof window === 'undefined') return MAX_PANEL_WIDTH;
	return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.floor(window.innerWidth * 0.45)));
}

function clampPanelWidth(width: number): number {
	return Math.min(getMaxPanelWidth(), Math.max(MIN_PANEL_WIDTH, Math.round(width)));
}

function readStoredPanelWidth(): number {
	if (typeof window === 'undefined') return DEFAULT_PANEL_WIDTH;
	try {
		const stored = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
		const width = stored ? Number(stored) : DEFAULT_PANEL_WIDTH;
		return Number.isFinite(width) ? clampPanelWidth(width) : DEFAULT_PANEL_WIDTH;
	} catch {
		return DEFAULT_PANEL_WIDTH;
	}
}

function storePanelWidth(width: number) {
	try {
		window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(clampPanelWidth(width)));
	} catch {
		// Ignore storage failures; resizing should still work for this session.
	}
}

function useIsDesktopPanel(): boolean {
	const [isDesktop, setIsDesktop] = useState(() => {
		if (typeof window === 'undefined') return true;
		return window.matchMedia('(min-width: 1024px)').matches;
	});

	useEffect(() => {
		const mediaQuery = window.matchMedia('(min-width: 1024px)');
		const update = () => setIsDesktop(mediaQuery.matches);
		update();
		mediaQuery.addEventListener('change', update);
		return () => mediaQuery.removeEventListener('change', update);
	}, []);

	return isDesktop;
}

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
				'absolute right-3 top-2 z-40 bg-dark-900/80 backdrop-blur',
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
	const [panelWidth, setPanelWidth] = useState(readStoredPanelWidth);
	const [resizing, setResizing] = useState(false);
	const isDesktop = useIsDesktopPanel();

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

	useEffect(() => {
		const handleResize = () => {
			setPanelWidth((width) => clampPanelWidth(width));
		};
		window.addEventListener('resize', handleResize);
		return () => window.removeEventListener('resize', handleResize);
	}, []);

	const panelWidthValue = isDesktop ? `${panelWidth}px` : 'min(100vw, 420px)';

	const handleResizeStart = (event: MouseEvent) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();

		const startX = event.clientX;
		const startWidth = panelWidth;
		let latestWidth = startWidth;
		const previousCursor = document.body.style.cursor;
		const previousUserSelect = document.body.style.userSelect;

		setResizing(true);
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const handleMouseMove = (moveEvent: MouseEvent) => {
			latestWidth = clampPanelWidth(startWidth + startX - moveEvent.clientX);
			setPanelWidth(latestWidth);
		};

		const handleMouseUp = () => {
			setResizing(false);
			storePanelWidth(latestWidth);
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousUserSelect;
			window.removeEventListener('mousemove', handleMouseMove);
			window.removeEventListener('mouseup', handleMouseUp);
		};

		window.addEventListener('mousemove', handleMouseMove);
		window.addEventListener('mouseup', handleMouseUp);
	};

	const handleResizeKeyDown = (event: KeyboardEvent) => {
		const step = event.shiftKey ? 48 : 16;
		let nextWidth: number | null = null;

		if (event.key === 'ArrowLeft') {
			nextWidth = clampPanelWidth(panelWidth + step);
		} else if (event.key === 'ArrowRight') {
			nextWidth = clampPanelWidth(panelWidth - step);
		} else if (event.key === 'Home') {
			nextWidth = MIN_PANEL_WIDTH;
		} else if (event.key === 'End') {
			nextWidth = getMaxPanelWidth();
		}

		if (nextWidth === null) return;
		event.preventDefault();
		setPanelWidth(nextWidth);
		storePanelWidth(nextWidth);
	};

	return (
		<>
			<div
				class={cn(
					'fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px] transition-opacity duration-200 lg:hidden',
					open ? 'opacity-100' : 'pointer-events-none opacity-0'
				)}
				onClick={() => {
					rightPanelTargetSignal.value = null;
				}}
			/>
			<div
				class={cn(
					'fixed right-0 top-0 z-30 h-safe-screen overflow-hidden bg-dark-800 shadow-2xl lg:relative lg:top-auto lg:z-auto lg:h-full lg:flex-shrink-0 lg:bg-transparent lg:shadow-none',
					!resizing && 'transition-[width] duration-200 ease-out'
				)}
				style={{ width: open ? panelWidthValue : '0px' }}
			>
				<div
					class={cn(
						'relative h-full overflow-hidden rounded-l-[28px] pt-safe transition-transform duration-200 ease-out lg:pt-0',
						open ? 'translate-x-0' : 'translate-x-full'
					)}
					style={{ width: panelWidthValue }}
				>
					<div
						role="separator"
						aria-label="Resize right panel"
						aria-orientation="vertical"
						aria-valuemin={MIN_PANEL_WIDTH}
						aria-valuemax={getMaxPanelWidth()}
						aria-valuenow={panelWidth}
						tabIndex={0}
						onMouseDown={handleResizeStart}
						onKeyDown={handleResizeKeyDown}
						class="group absolute left-0 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none outline-none lg:block"
					>
						<div class="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-white/20 group-focus-visible:bg-white/30" />
					</div>
					{renderedTarget?.type === 'git' && <GitPanel sessionId={renderedTarget.sessionId} />}
				</div>
			</div>
		</>
	);
}
