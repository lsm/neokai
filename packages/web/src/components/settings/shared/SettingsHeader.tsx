/**
 * SettingsHeader - Header component for settings sections
 *
 * Displays section title, description, and optional breadcrumbs.
 */

export interface BreadcrumbItem {
	label: string;
	href?: string;
	onClick?: () => void;
}

export interface SettingsHeaderProps {
	title: string;
	description?: string;
	breadcrumbs?: readonly BreadcrumbItem[];
}

export function SettingsHeader({ title, description, breadcrumbs }: SettingsHeaderProps) {
	return (
		<div class="mb-8">
			{/* Breadcrumbs */}
			{breadcrumbs && breadcrumbs.length > 0 && (
				<nav class="mb-4 flex items-center gap-2 text-sm">
					{breadcrumbs.map((item, index) => (
						<>
							{index > 0 && (
								<svg
									class="h-4 w-4 text-gray-500"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M9 5l7 7-7 7"
									/>
								</svg>
							)}
							{item.href ? (
								<a href={item.href} class="text-gray-400 transition-colors hover:text-gray-200">
									{item.label}
								</a>
							) : (
								<span
									class={`${
										index === breadcrumbs.length - 1
											? 'text-gray-200'
											: 'cursor-pointer text-gray-400 transition-colors hover:text-gray-200 hover:underline'
									} ${item.onClick ? 'cursor-pointer' : ''}`}
									onClick={item.onClick}
								>
									{item.label}
								</span>
							)}
						</>
					))}
				</nav>
			)}

			{/* Title and Description */}
			<div>
				<h1 class="text-2xl font-semibold text-gray-100">{title}</h1>
				{description && <p class="mt-2 text-sm text-gray-400">{description}</p>}
			</div>
		</div>
	);
}
