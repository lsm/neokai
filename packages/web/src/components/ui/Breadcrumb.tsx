import { ChevronRightIcon } from '../icons/index';

export interface BreadcrumbItem {
	label: string;
	onClick?: () => void;
}

export interface BreadcrumbProps {
	items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
	return (
		<nav class="flex items-center gap-1">
			{items.map((item, index) => {
				const isLast = index === items.length - 1;
				return (
					<>
						{index > 0 && (
							<ChevronRightIcon className="w-3 h-3 text-gray-500 flex-shrink-0" />
						)}
						{isLast ? (
							<span class="text-sm text-gray-200 font-medium truncate max-w-[200px]">
								{item.label}
							</span>
						) : (
							<button
								class="text-sm text-gray-400 hover:text-gray-200 cursor-pointer transition-colors truncate max-w-[200px]"
								onClick={item.onClick}
							>
								{item.label}
							</button>
						)}
					</>
				);
			})}
		</nav>
	);
}
