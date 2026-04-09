import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import {
	navSectionSignal,
	currentRoomIdSignal,
	currentRoomSessionIdSignal,
	currentRoomTaskIdSignal,
	currentRoomActiveTabSignal,
	currentRoomAgentActiveSignal,
	currentSpaceIdSignal,
	currentSpaceViewModeSignal,
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	type NavSection,
} from '../lib/signals.ts';
import {
	navigateToSessions,
	navigateToSettings,
	navigateToRooms,
	navigateToInbox,
	navigateToRoomTab,
	navigateToSpace,
	navigateToSpaceTasks,
	navigateToSpaceAgent,
	navigateToSpaceConfigure,
} from '../lib/router.ts';
import { inboxStore } from '../lib/inbox-store.ts';
import { InboxBadge } from '../components/ui/InboxBadge.tsx';

interface TabItem {
	id:
		| NavSection
		| 'room-agent'
		| 'room-overview'
		| 'room-tasks'
		| 'room-agents'
		| 'room-missions'
		| 'space-overview'
		| 'space-tasks'
		| 'space-agent'
		| 'space-settings';
	label: string;
	icon: () => JSX.Element;
}

const InboxIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
		/>
	</svg>
);

const RoomsIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
		/>
	</svg>
);

const ChatsIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
		/>
	</svg>
);

const SettingsIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
		/>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
		/>
	</svg>
);

const MissionIcon = () => (
	<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M13 10V3L4 14h7v7l9-11h-7z"
		/>
	</svg>
);

const TasksIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
		/>
	</svg>
);

const AgentsIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
		/>
	</svg>
);

const RoomChatIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
		/>
	</svg>
);

const RoomOverviewIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
		/>
	</svg>
);

const SpaceOverviewIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
		/>
	</svg>
);

const SpaceTasksIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
		/>
	</svg>
);

const SpaceChatIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
		/>
	</svg>
);

const SpaceSettingsIcon = () => (
	<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
		/>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={2}
			d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
		/>
	</svg>
);

const SPACE_BOTTOM_TABS: TabItem[] = [
	{ id: 'space-overview', label: 'Overview', icon: SpaceOverviewIcon },
	{ id: 'space-tasks', label: 'Tasks', icon: SpaceTasksIcon },
	{ id: 'space-agent', label: 'Agent', icon: SpaceChatIcon },
	{ id: 'space-settings', label: 'Settings', icon: SpaceSettingsIcon },
];

const GLOBAL_BOTTOM_TABS: TabItem[] = [
	{ id: 'inbox', label: 'Inbox', icon: InboxIcon },
	{ id: 'rooms', label: 'Rooms', icon: RoomsIcon },
	{ id: 'chats', label: 'Chats', icon: ChatsIcon },
	{ id: 'settings', label: 'Settings', icon: SettingsIcon },
];

const ROOM_BOTTOM_TABS: TabItem[] = [
	{ id: 'room-agent', label: 'Coord.', icon: RoomChatIcon },
	{ id: 'room-overview', label: 'Overview', icon: RoomOverviewIcon },
	{ id: 'room-tasks', label: 'Tasks', icon: TasksIcon },
	{ id: 'room-agents', label: 'Agents', icon: AgentsIcon },
	{ id: 'room-missions', label: 'Missions', icon: MissionIcon },
];

export function BottomTabBar() {
	const innerRef = useRef<HTMLDivElement>(null);

	const navSection = navSectionSignal.value;
	const roomId = currentRoomIdSignal.value;
	const spaceId = currentSpaceIdSignal.value;
	const inboxBadgeCount = inboxStore.reviewCount.value;

	const roomSessionId = currentRoomSessionIdSignal.value;
	const roomTaskId = currentRoomTaskIdSignal.value;
	const isInRoomContext = navSection === 'rooms' && roomId !== null;
	const isInSpaceContext = navSection === 'spaces' && spaceId !== null;

	// Context key tracks which tab set is rendered. When it changes, the inner
	// div is recreated (via its `key` prop) and the ResizeObserver must re-attach.
	const contextKey = isInSpaceContext ? 'space' : isInRoomContext ? 'room' : 'global';

	useEffect(() => {
		const inner = innerRef.current;
		if (!inner) return;

		const updateHeight = () => {
			if (document.documentElement.classList.contains('keyboard-open')) return;
			const h = inner.offsetHeight;
			document.documentElement.style.setProperty('--bottom-bar-height', h + 'px');
		};

		// Measure the inner content div (excludes pb-safe) so --bottom-bar-height
		// only tracks tab content height. Safe area is handled separately via
		// pb-safe on the main content wrapper in App.tsx.
		const ro = new ResizeObserver(updateHeight);
		ro.observe(inner);

		let rafId = 0;
		const scheduleUpdate = () => {
			cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(updateHeight);
		};
		window.addEventListener('resize', scheduleUpdate);

		const vv = window.visualViewport;
		if (vv) vv.addEventListener('resize', scheduleUpdate);

		updateHeight();
		const timer = setTimeout(updateHeight, 300);

		return () => {
			clearTimeout(timer);
			ro.disconnect();
			window.removeEventListener('resize', scheduleUpdate);
			if (vv) vv.removeEventListener('resize', scheduleUpdate);
			cancelAnimationFrame(rafId);
			document.documentElement.style.setProperty('--bottom-bar-height', '0px');
		};
	}, [contextKey]);

	const isViewingRoomAgent = currentRoomAgentActiveSignal.value;
	// Overview is only active when on the room dashboard (no task, no session, no agent chat)
	const isViewingRoomDashboard =
		!isViewingRoomAgent && roomTaskId === null && roomSessionId === null;

	const spaceViewMode = currentSpaceViewModeSignal.value;
	const spaceSessionId = currentSpaceSessionIdSignal.value;
	const spaceTaskId = currentSpaceTaskIdSignal.value;

	const tabs = isInSpaceContext
		? SPACE_BOTTOM_TABS
		: isInRoomContext
			? ROOM_BOTTOM_TABS
			: GLOBAL_BOTTOM_TABS;

	const handleTabClick = (id: TabItem['id']) => {
		switch (id) {
			case 'inbox':
				navigateToInbox();
				break;
			case 'rooms':
				navigateToRooms();
				break;
			case 'chats':
				navigateToSessions();
				break;
			case 'settings':
				navigateToSettings();
				break;
			case 'room-overview':
				if (roomId) navigateToRoomTab(roomId, 'overview');
				break;
			case 'room-tasks':
				if (roomId) navigateToRoomTab(roomId, 'tasks');
				break;
			case 'room-agent':
				if (roomId) navigateToRoomTab(roomId, 'chat');
				break;
			case 'room-agents':
				if (roomId) navigateToRoomTab(roomId, 'agents');
				break;
			case 'room-missions':
				if (roomId) navigateToRoomTab(roomId, 'goals');
				break;
			case 'space-overview':
				if (spaceId) navigateToSpace(spaceId);
				break;
			case 'space-tasks':
				if (spaceId) navigateToSpaceTasks(spaceId);
				break;
			case 'space-agent':
				if (spaceId) navigateToSpaceAgent(spaceId);
				break;
			case 'space-settings':
				if (spaceId) navigateToSpaceConfigure(spaceId);
				break;
		}
	};

	const isTabActive = (id: TabItem['id']): boolean => {
		if (isInSpaceContext) {
			if (id === 'space-settings') return spaceViewMode === 'configure';
			if (id === 'space-agent') return spaceSessionId === `space:chat:${spaceId}`;
			if (id === 'space-tasks') return spaceViewMode === 'tasks' && spaceTaskId === null;
			if (id === 'space-overview')
				return (
					spaceViewMode === 'overview' &&
					spaceTaskId === null &&
					spaceSessionId !== `space:chat:${spaceId}`
				);
		}
		if (isInRoomContext) {
			if (id === 'room-agent') return currentRoomActiveTabSignal.value === 'chat';
			if (id === 'room-tasks') return currentRoomActiveTabSignal.value === 'tasks';
			if (id === 'room-agents') return currentRoomActiveTabSignal.value === 'agents';
			if (id === 'room-missions') return currentRoomActiveTabSignal.value === 'goals';
			if (id === 'room-overview')
				return (
					isViewingRoomDashboard &&
					navSection === 'rooms' &&
					!['goals', 'tasks', 'agents', 'chat'].includes(currentRoomActiveTabSignal.value ?? '')
				);
		}
		return navSection === id;
	};

	return (
		<div
			data-testid="bottom-tab-bar"
			class="flex md:hidden fixed bottom-0 left-0 right-0 z-50 bg-dark-900/90 backdrop-blur-md pb-safe"
			role="tablist"
			aria-label={
				isInSpaceContext
					? 'Space navigation'
					: isInRoomContext
						? 'Room navigation'
						: 'Main navigation'
			}
		>
			<div
				ref={innerRef}
				class="flex w-full border-t border-dark-700 transition-opacity duration-200 ease-out"
				key={contextKey}
			>
				{tabs.map((tab) => {
					const isActive = isTabActive(tab.id);
					const isInbox = tab.id === 'inbox';
					const badge = isInbox ? inboxBadgeCount : 0;

					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={isActive}
							aria-label={tab.label}
							onClick={() => handleTabClick(tab.id)}
							class={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors duration-150 ${
								isActive ? 'text-indigo-400' : 'text-gray-500 active:text-gray-300'
							}`}
						>
							<div class="relative">
								<tab.icon />
								<InboxBadge count={badge} class="absolute -top-0.5 -right-0.5" />
							</div>
							<span class="text-[10px] font-medium leading-none">{tab.label}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
