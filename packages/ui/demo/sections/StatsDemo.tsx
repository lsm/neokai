function classNames(...classes: (string | boolean | undefined | null)[]) {
	return classes.filter(Boolean).join(' ');
}

const stats1 = [
	{ name: 'Revenue', value: '$405,091.00', change: '+4.75%', changeType: 'positive' },
	{ name: 'Overdue invoices', value: '$12,787.00', change: '+54.02%', changeType: 'negative' },
	{ name: 'Outstanding invoices', value: '$245,988.00', change: '-1.39%', changeType: 'positive' },
	{ name: 'Expenses', value: '$30,156.00', change: '+10.18%', changeType: 'negative' },
];

const stats2 = [
	{ name: 'Number of deploys', value: '405' },
	{ name: 'Average deploy time', value: '3.65', unit: 'mins' },
	{ name: 'Number of servers', value: '3' },
	{ name: 'Success rate', value: '98.5%' },
];

const stats3 = [
	{ name: 'Total Subscribers', stat: '71,897' },
	{ name: 'Avg. Open Rate', stat: '58.16%' },
	{ name: 'Avg. Click Rate', stat: '24.57%' },
];

function WithTrending() {
	return (
		<dl class="mx-auto grid grid-cols-1 gap-px bg-gray-900/5 sm:grid-cols-2 lg:grid-cols-4 dark:bg-white/10">
			{stats1.map((stat) => (
				<div
					key={stat.name}
					class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 bg-white px-4 py-10 sm:px-6 xl:px-8 dark:bg-gray-900"
				>
					<dt class="text-sm/6 font-medium text-gray-500 dark:text-gray-400">{stat.name}</dt>
					<dd
						class={classNames(
							stat.changeType === 'negative'
								? 'text-rose-600 dark:text-rose-400'
								: 'text-gray-700 dark:text-gray-300',
							'text-xs font-medium'
						)}
					>
						{stat.change}
					</dd>
					<dd class="w-full flex-none text-3xl/10 font-medium tracking-tight text-gray-900 dark:text-white">
						{stat.value}
					</dd>
				</div>
			))}
		</dl>
	);
}

function Simple() {
	return (
		<div class="bg-white dark:bg-gray-900">
			<div class="mx-auto max-w-7xl">
				<div class="grid grid-cols-1 gap-px bg-gray-900/5 sm:grid-cols-2 lg:grid-cols-4 dark:bg-white/10">
					{stats2.map((stat) => (
						<div key={stat.name} class="bg-white px-4 py-6 sm:px-6 lg:px-8 dark:bg-gray-900">
							<p class="text-sm/6 font-medium text-gray-500 dark:text-gray-400">{stat.name}</p>
							<p class="mt-2 flex items-baseline gap-x-2">
								<span class="text-4xl font-semibold tracking-tight text-gray-900 dark:text-white">
									{stat.value}
								</span>
								{stat.unit ? (
									<span class="text-sm text-gray-500 dark:text-gray-400">{stat.unit}</span>
								) : null}
							</p>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

function SimpleInCards() {
	return (
		<div>
			<h3 class="text-base font-semibold text-gray-900 dark:text-white">Last 30 days</h3>
			<dl class="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-3">
				{stats3.map((item) => (
					<div
						key={item.name}
						class="overflow-hidden rounded-lg bg-white px-4 py-5 shadow-sm sm:p-6 dark:bg-gray-800/75 dark:inset-ring dark:inset-ring-white/10"
					>
						<dt class="truncate text-sm font-medium text-gray-500 dark:text-gray-400">
							{item.name}
						</dt>
						<dd class="mt-1 text-3xl font-semibold tracking-tight text-gray-900 dark:text-white">
							{item.stat}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

export function StatsDemo() {
	return (
		<div class="space-y-12">
			<section>
				<h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">With Trending</h2>
				<WithTrending />
			</section>
			<section>
				<h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">Simple</h2>
				<Simple />
			</section>
			<section>
				<h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">Simple in Cards</h2>
				<SimpleInCards />
			</section>
		</div>
	);
}
