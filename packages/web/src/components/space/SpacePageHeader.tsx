import { borderColors } from '../../lib/design-tokens';
import { MobileMenuButton } from '../ui/MobileMenuButton';

interface SpacePageHeaderProps {
	spaceName: string;
	pageTitle: string;
}

export function SpacePageHeader({ spaceName, pageTitle }: SpacePageHeaderProps) {
	return (
		<div
			class={`flex-shrink-0 bg-dark-850 border-b ${borderColors.ui.default} px-4 py-2.5 relative z-10`}
		>
			<div class="flex items-center gap-3">
				<MobileMenuButton />
				<div class="flex-1 min-w-0">
					<div class="text-xs text-gray-500 truncate">{spaceName}</div>
					<h2 class="text-sm font-semibold text-gray-100 truncate">{pageTitle}</h2>
				</div>
			</div>
		</div>
	);
}
