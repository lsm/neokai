import type { JSX } from 'preact';
import { navSectionSignal, type NavSection } from '../lib/signals.ts';
import {
	navigateToSessions,
	navigateToSettings,
	navigateToRooms,
	navigateToInbox,
} from '../lib/router.ts';
import { inboxStore } from '../lib/inbox-store.ts';
import { InboxBadge } from '../components/ui/InboxBadge.tsx';

interface TabItem {
	id: NavSection;
	label: string;
	icon: () => JSX.Element;
}

const BOTTOM_TABS: TabItem[] = [
	{
		id: 'inbox',
		label: 'Inbox',
		icon: () => (
			<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={2}
					d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
				/>
			</svg>
		),
	},
	{
		id: 'rooms',
		label: 'Rooms',
		icon: () => (
			<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={2}
					d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
				/>
			</svg>
		),
	},
	{
		id: 'chats',
		label: 'Chats',
		icon: () => (
			<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={2}
					d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
				/>
			</svg>
		),
	},
	{
		id: 'settings',
		label: 'Settings',
		icon: () => (
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
		),
	},
];

function handleTabClick(id: NavSection): void {
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
	}
}

export function BottomTabBar() {
	const navSection = navSectionSignal.value;
	const inboxBadgeCount = inboxStore.reviewCount.value;

	return (
		<div
			class="flex md:hidden fixed bottom-0 left-0 right-0 z-50 bg-dark-900/90 backdrop-blur-md border-t border-dark-700 pb-safe"
			role="tablist"
			aria-label="Main navigation"
		>
			{BOTTOM_TABS.map((tab) => {
				const isActive = navSection === tab.id;
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
	);
}
