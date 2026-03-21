import { navSectionSignal, type NavSection } from '../lib/signals.ts';
import {
	navigateToSessions,
	navigateToSettings,
	navigateToHome,
	navigateToRooms,
	navigateToInbox,
	navigateToSpaces,
} from '../lib/router.ts';
import { NavIconButton } from '../components/ui/NavIconButton.tsx';
import { borderColors } from '../lib/design-tokens.ts';
import { DaemonStatusIndicator } from '../components/DaemonStatusIndicator.tsx';
import { MAIN_NAV_ITEMS, SETTINGS_NAV_ITEM } from '../lib/nav-config.tsx';

// Static badge count for inbox — Task 3.2 will provide dynamic data
const inboxBadgeCount = 0;

export function NavRail() {
	const navSection = navSectionSignal.value;

	const handleNavClick = (section: NavSection) => {
		switch (section) {
			case 'home':
				navSectionSignal.value = 'home';
				navigateToHome();
				break;
			case 'chats':
				navigateToSessions();
				break;
			case 'rooms':
				navigateToRooms();
				break;
			case 'inbox':
				navigateToInbox();
				break;
			case 'spaces':
				navigateToSpaces();
				break;
			case 'settings':
				navigateToSettings();
				break;
		}
	};

	return (
		<div
			class={`
				hidden md:relative md:flex
				w-16 h-screen
				bg-dark-950 border-r ${borderColors.ui.default}
				flex-col items-center py-4
			`}
		>
			{/* Logo */}
			<div class="text-2xl mb-6" title="NeoKai">
				🤖
			</div>

			{/* Nav Items */}
			<nav class="flex-1 flex flex-col gap-1">
				{MAIN_NAV_ITEMS.map((item) => {
					if (item.id === 'inbox') {
						const badge = inboxBadgeCount;
						return (
							<div key={item.id} class="relative">
								<NavIconButton
									active={navSection === item.id}
									onClick={() => handleNavClick(item.id)}
									label={item.label}
								>
									{item.icon}
								</NavIconButton>
								{badge > 0 && (
									<div class="w-2 h-2 rounded-full bg-red-500 absolute top-1 right-1 flex items-center justify-center">
										{badge <= 9 ? (
											<span class="text-white text-[8px] font-bold leading-none">{badge}</span>
										) : (
											<span class="text-white text-[8px] font-bold leading-none">9+</span>
										)}
									</div>
								)}
							</div>
						);
					}
					return (
						<NavIconButton
							key={item.id}
							active={navSection === item.id}
							onClick={() => handleNavClick(item.id)}
							label={item.label}
						>
							{item.icon}
						</NavIconButton>
					);
				})}
			</nav>

			{/* Bottom - Daemon Status & Settings */}
			<div class="mt-auto flex flex-col gap-1">
				<DaemonStatusIndicator />

				<NavIconButton
					active={navSection === SETTINGS_NAV_ITEM.id}
					onClick={() => handleNavClick(SETTINGS_NAV_ITEM.id)}
					label={SETTINGS_NAV_ITEM.label}
				>
					{SETTINGS_NAV_ITEM.icon}
				</NavIconButton>
			</div>
		</div>
	);
}
