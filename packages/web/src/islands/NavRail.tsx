import { navSectionSignal, type NavSection } from '../lib/signals.ts';
import { navigateToSessions, navigateToSettings, navigateToRooms } from '../lib/router.ts';
import { NavIconButton } from '../components/ui/NavIconButton.tsx';
import { borderColors } from '../lib/design-tokens.ts';
import { DaemonStatusIndicator } from '../components/DaemonStatusIndicator.tsx';
import { MAIN_NAV_ITEMS, SETTINGS_NAV_ITEM } from '../lib/nav-config.tsx';
import { NeoKaiLogo } from '../components/icons/index.tsx';
import { t } from '../lib/i18n.ts';

export function NavRail() {
	const navSection = navSectionSignal.value;

	const handleNavClick = (section: NavSection) => {
		switch (section) {
			case 'chats':
				navigateToSessions();
				break;
			case 'rooms':
				navigateToRooms();
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
			<div class="mb-6" title="NeoKai">
				<NeoKaiLogo className="w-7 h-7 text-blue-400" />
			</div>

			{/* Nav Items */}
			<nav class="flex-1 flex flex-col gap-1">
				{MAIN_NAV_ITEMS.map((item) => (
					<NavIconButton
						key={item.id}
						active={navSection === item.id}
						onClick={() => handleNavClick(item.id)}
						label={t(item.label)}
					>
						{item.icon}
					</NavIconButton>
				))}
			</nav>

			{/* Bottom - Daemon Status & Settings */}
			<div class="mt-auto flex flex-col gap-1">
				<DaemonStatusIndicator />

				<NavIconButton
					active={navSection === SETTINGS_NAV_ITEM.id}
					onClick={() => handleNavClick(SETTINGS_NAV_ITEM.id)}
					label={t(SETTINGS_NAV_ITEM.label)}
				>
					{SETTINGS_NAV_ITEM.icon}
				</NavIconButton>
			</div>
		</div>
	);
}
