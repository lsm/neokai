import { classNames } from '../../src/internal/class-names.ts';

const simpleNavigation = [
	{ name: 'Dashboard', href: '#', current: true },
	{ name: 'Team', href: '#', current: false },
	{ name: 'Projects', href: '#', current: false },
	{ name: 'Calendar', href: '#', current: false },
	{ name: 'Documents', href: '#', current: false },
	{ name: 'Reports', href: '#', current: false },
];

const badgeNavigation = [
	{ name: 'Dashboard', href: '#', count: '5', current: true },
	{ name: 'Team', href: '#', current: false },
	{ name: 'Projects', href: '#', count: '12', current: false },
	{ name: 'Calendar', href: '#', count: '20+', current: false },
	{ name: 'Documents', href: '#', current: false },
	{ name: 'Reports', href: '#', current: false },
];

export function SimpleVerticalNavigation() {
	return (
		<nav aria-label="Sidebar" class="flex flex-1 flex-col">
			<ul role="list" class="-mx-2 space-y-1">
				{simpleNavigation.map((item) => (
					<li key={item.name}>
						<a
							href={item.href}
							class={classNames(
								item.current
									? 'bg-surface-0 text-accent-500 dark:bg-white/5 dark:text-white'
									: 'text-text-secondary hover:bg-surface-0 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
								'group flex gap-x-3 rounded-md p-2 pl-3 text-sm/6 font-semibold'
							)}
						>
							{item.name}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}

export function BadgeVerticalNavigation() {
	return (
		<nav aria-label="Sidebar" class="flex flex-1 flex-col">
			<ul role="list" class="-mx-2 space-y-1">
				{badgeNavigation.map((item) => (
					<li key={item.name}>
						<a
							href={item.href}
							class={classNames(
								item.current
									? 'bg-surface-0 text-accent-500 dark:bg-white/5 dark:text-white'
									: 'text-text-secondary hover:bg-surface-0 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
								'group flex gap-x-3 rounded-md p-2 pl-3 text-sm/6 font-semibold'
							)}
						>
							{item.name}
							{item.count ? (
								<span
									aria-hidden="true"
									class="ml-auto w-9 min-w-max rounded-full bg-white px-2.5 py-0.5 text-center text-xs/5 font-medium whitespace-nowrap text-text-secondary outline-1 -outline-offset-1 outline-surface-border dark:bg-surface-1 dark:text-text-tertiary dark:outline-white/10"
								>
									{item.count}
								</span>
							) : null}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}

export function VerticalNavigationDemo() {
	return (
		<div class="flex flex-col gap-8">
			<div>
				<h3 class="text-sm font-medium text-text-secondary mb-3">Simple</h3>
				<SimpleVerticalNavigation />
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-secondary mb-3">With Badges</h3>
				<BadgeVerticalNavigation />
			</div>
		</div>
	);
}
