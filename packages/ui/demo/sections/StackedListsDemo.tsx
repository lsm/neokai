const people = [
	{
		name: 'Leslie Alexander',
		email: 'leslie.alexander@example.com',
		role: 'Co-Founder / CEO',
		imageUrl:
			'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
		href: '#',
		lastSeen: '3h ago',
		lastSeenDateTime: '2023-01-23T13:23Z',
	},
	{
		name: 'Michael Foster',
		email: 'michael.foster@example.com',
		role: 'Co-Founder / CTO',
		imageUrl:
			'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
		href: '#',
		lastSeen: '3h ago',
		lastSeenDateTime: '2023-01-23T13:23Z',
	},
	{
		name: 'Dries Vincent',
		email: 'dries.vincent@example.com',
		role: 'Business Relations',
		imageUrl:
			'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
		href: '#',
		lastSeen: null,
	},
	{
		name: 'Lindsay Walton',
		email: 'lindsay.walton@example.com',
		role: 'Front-end Developer',
		imageUrl:
			'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
		href: '#',
		lastSeen: '3h ago',
		lastSeenDateTime: '2023-01-23T13:23Z',
	},
	{
		name: 'Courtney Henry',
		email: 'courtney.henry@example.com',
		role: 'Designer',
		imageUrl:
			'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
		href: '#',
		lastSeen: '3h ago',
		lastSeenDateTime: '2023-01-23T13:23Z',
	},
	{
		name: 'Tom Cook',
		email: 'tom.cook@example.com',
		role: 'Director of Product',
		imageUrl:
			'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
		href: '#',
		lastSeen: null,
	},
];

function ChevronRightIcon({ class: className }: { class?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 20 20"
			fill="currentColor"
			aria-hidden="true"
			class={className}
		>
			<path
				fill-rule="evenodd"
				d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z"
				clip-rule="evenodd"
			/>
		</svg>
	);
}

function OnlineIndicator() {
	return (
		<div class="mt-1 flex items-center gap-x-1.5">
			<div class="flex-none rounded-full bg-green-500/20 p-1 dark:bg-green-500/30">
				<div class="size-1.5 rounded-full bg-green-500" />
			</div>
			<p class="text-xs/5 text-text-secondary">Online</p>
		</div>
	);
}

function PersonRowSimple({ person }: { person: (typeof people)[0] }) {
	return (
		<li class="relative flex justify-between gap-x-6 px-4 py-5 hover:bg-surface-1 sm:px-6 dark:hover:bg-white/2.5">
			<div class="flex min-w-0 gap-x-4">
				<img
					alt=""
					src={person.imageUrl}
					class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
				/>
				<div class="min-w-0 flex-auto">
					<p class="text-sm/6 font-semibold text-text-primary">
						<a href={person.href}>
							<span class="absolute inset-x-0 -top-px bottom-0" />
							{person.name}
						</a>
					</p>
					<p class="mt-1 flex text-xs/5 text-text-secondary">
						<a href={`mailto:${person.email}`} class="relative truncate hover:underline">
							{person.email}
						</a>
					</p>
				</div>
			</div>
			<div class="flex shrink-0 items-center gap-x-4">
				<div class="hidden sm:flex sm:flex-col sm:items-end">
					<p class="text-sm/6 text-text-primary">{person.role}</p>
					{person.lastSeen ? (
						<p class="mt-1 text-xs/5 text-text-secondary">
							Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
						</p>
					) : (
						<OnlineIndicator />
					)}
				</div>
				<ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
			</div>
		</li>
	);
}

function PersonRowTwoColumns({ person }: { person: (typeof people)[0] }) {
	return (
		<li key={person.email} class="relative flex justify-between py-5">
			<div class="flex gap-x-4 pr-6 sm:w-1/2 sm:flex-none">
				<img
					alt=""
					src={person.imageUrl}
					class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
				/>
				<div class="min-w-0 flex-auto">
					<p class="text-sm/6 font-semibold text-text-primary">
						<a href={person.href}>
							<span class="absolute inset-x-0 -top-px bottom-0" />
							{person.name}
						</a>
					</p>
					<p class="mt-1 flex text-xs/5 text-text-secondary">
						<a href={`mailto:${person.email}`} class="relative truncate hover:underline">
							{person.email}
						</a>
					</p>
				</div>
			</div>
			<div class="flex items-center justify-between gap-x-4 sm:w-1/2 sm:flex-none">
				<div class="hidden sm:block">
					<p class="text-sm/6 text-text-primary">{person.role}</p>
					{person.lastSeen ? (
						<p class="mt-1 text-xs/5 text-text-secondary">
							Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
						</p>
					) : (
						<OnlineIndicator />
					)}
				</div>
				<ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
			</div>
		</li>
	);
}

function PersonRowFullWidth({ person }: { person: (typeof people)[0] }) {
	return (
		<li key={person.email} class="relative py-5 hover:bg-surface-1 dark:hover:bg-white/2.5">
			<div class="px-4 sm:px-6 lg:px-8">
				<div class="mx-auto flex max-w-4xl justify-between gap-x-6">
					<div class="flex min-w-0 gap-x-4">
						<img
							alt=""
							src={person.imageUrl}
							class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
						/>
						<div class="min-w-0 flex-auto">
							<p class="text-sm/6 font-semibold text-text-primary">
								<a href={person.href}>
									<span class="absolute inset-x-0 -top-px bottom-0" />
									{person.name}
								</a>
							</p>
							<p class="mt-1 flex text-xs/5 text-text-secondary">
								<a href={`mailto:${person.email}`} class="relative truncate hover:underline">
									{person.email}
								</a>
							</p>
						</div>
					</div>
					<div class="flex shrink-0 items-center gap-x-4">
						<div class="hidden sm:flex sm:flex-col sm:items-end">
							<p class="text-sm/6 text-text-primary">{person.role}</p>
							{person.lastSeen ? (
								<p class="mt-1 text-xs/5 text-text-secondary">
									Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
								</p>
							) : (
								<OnlineIndicator />
							)}
						</div>
						<ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
					</div>
				</div>
			</div>
		</li>
	);
}

function PersonRowPlain({ person }: { person: (typeof people)[0] }) {
	return (
		<li key={person.email} class="flex justify-between gap-x-6 py-5">
			<div class="flex min-w-0 gap-x-4">
				<img
					alt=""
					src={person.imageUrl}
					class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
				/>
				<div class="min-w-0 flex-auto">
					<p class="text-sm/6 font-semibold text-text-primary">{person.name}</p>
					<p class="mt-1 truncate text-xs/5 text-text-secondary">{person.email}</p>
				</div>
			</div>
			<div class="hidden shrink-0 sm:flex sm:flex-col sm:items-end">
				<p class="text-sm/6 text-text-primary">{person.role}</p>
				{person.lastSeen ? (
					<p class="mt-1 text-xs/5 text-text-secondary">
						Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
					</p>
				) : (
					<OnlineIndicator />
				)}
			</div>
		</li>
	);
}

export function StackedListsDemo() {
	return (
		<div class="space-y-8">
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Simple stacked list in card</h3>
				<ul
					role="list"
					class="divide-y divide-surface-2 overflow-hidden bg-surface-0 shadow-sm outline outline-1 outline-black/5 sm:rounded-xl dark:divide-white/5 dark:bg-surface-0/50 dark:shadow-none dark:outline-white/10 dark:sm:-outline-offset-1"
				>
					{people.map((person) => (
						<PersonRowSimple person={person} />
					))}
				</ul>
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Plain stacked list with links</h3>
				<ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
					{people.map((person) => (
						<li
							key={person.email}
							class="relative flex justify-between gap-x-6 px-4 py-5 hover:bg-surface-1 sm:px-6 lg:px-8 dark:hover:bg-white/2.5"
						>
							<div class="flex min-w-0 gap-x-4">
								<img
									alt=""
									src={person.imageUrl}
									class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
								/>
								<div class="min-w-0 flex-auto">
									<p class="text-sm/6 font-semibold text-text-primary">
										<a href={person.href}>
											<span class="absolute inset-x-0 -top-px bottom-0" />
											{person.name}
										</a>
									</p>
									<p class="mt-1 flex text-xs/5 text-text-secondary">
										<a href={`mailto:${person.email}`} class="relative truncate hover:underline">
											{person.email}
										</a>
									</p>
								</div>
							</div>
							<div class="flex shrink-0 items-center gap-x-4">
								<div class="hidden sm:flex sm:flex-col sm:items-end">
									<p class="text-sm/6 text-text-primary">{person.role}</p>
									{person.lastSeen ? (
										<p class="mt-1 text-xs/5 text-text-secondary">
											Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
										</p>
									) : (
										<OnlineIndicator />
									)}
								</div>
								<ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
							</div>
						</li>
					))}
				</ul>
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Stacked list in card</h3>
				<div class="overflow-hidden bg-surface-0 shadow-sm outline outline-1 outline-black/5 dark:bg-surface-0/50 dark:shadow-none dark:outline-white/10 sm:rounded-xl">
					<ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
						{people.map((person) => (
							<PersonRowPlain person={person} />
						))}
					</ul>
				</div>
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Two columns with links</h3>
				<ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
					{people.map((person) => (
						<PersonRowTwoColumns person={person} />
					))}
				</ul>
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Full width with links</h3>
				<ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
					{people.map((person) => (
						<PersonRowFullWidth person={person} />
					))}
				</ul>
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">
					Full width with constrained content
				</h3>
				<ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
					{people.map((person) => (
						<li key={person.email} class="relative flex justify-between gap-x-6 py-5">
							<div class="flex min-w-0 gap-x-4">
								<img
									alt=""
									src={person.imageUrl}
									class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
								/>
								<div class="min-w-0 flex-auto">
									<p class="text-sm/6 font-semibold text-text-primary">
										<a href={person.href}>
											<span class="absolute inset-x-0 -top-px bottom-0" />
											{person.name}
										</a>
									</p>
									<p class="mt-1 flex text-xs/5 text-text-secondary">
										<a href={`mailto:${person.email}`} class="relative truncate hover:underline">
											{person.email}
										</a>
									</p>
								</div>
							</div>
							<div class="flex shrink-0 items-center gap-x-4">
								<div class="hidden sm:flex sm:flex-col sm:items-end">
									<p class="text-sm/6 text-text-primary">{person.role}</p>
									{person.lastSeen ? (
										<p class="mt-1 text-xs/5 text-text-secondary">
											Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
										</p>
									) : (
										<OnlineIndicator />
									)}
								</div>
								<ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
							</div>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}
