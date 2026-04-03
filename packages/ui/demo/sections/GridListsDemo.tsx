const people = [
	{
		name: 'Jane Cooper',
		title: 'Paradigm Representative',
		role: 'Admin',
		email: 'janecooper@example.com',
		telephone: '+1-202-555-0170',
		imageUrl:
			'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Cody Fisher',
		title: 'Lead Security Associate',
		role: 'Admin',
		email: 'codyfisher@example.com',
		telephone: '+1-202-555-0114',
		imageUrl:
			'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Esther Howard',
		title: 'Assurance Administrator',
		email: 'estherhoward@example.com',
		telephone: '+1-202-555-0143',
		role: 'Admin',
		imageUrl:
			'https://images.unsplash.com/photo-1520813792240-56fc4a3765a7?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Jenny Wilson',
		title: 'Chief Accountability Analyst',
		role: 'Admin',
		email: 'jennywilson@example.com',
		telephone: '+1-202-555-0184',
		imageUrl:
			'https://images.unsplash.com/photo-1498551172505-8ee7ad69f235?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Kristin Watson',
		title: 'Investor Data Orchestrator',
		role: 'Admin',
		email: 'kristinwatson@example.com',
		telephone: '+1-202-555-0191',
		imageUrl:
			'https://images.unsplash.com/photo-1532417344469-368f9ae6d187?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Cameron Williamson',
		title: 'Product Infrastructure Executive',
		role: 'Admin',
		email: 'cameronwilliamson@example.com',
		telephone: '+1-202-555-0108',
		imageUrl:
			'https://images.unsplash.com/photo-1566492031773-4f4e44671857?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Courtney Henry',
		title: 'Investor Factors Associate',
		role: 'Admin',
		email: 'courtneyhenry@example.com',
		telephone: '+1-202-555-0104',
		imageUrl:
			'https://images.unsplash.com/photo-1534751516642-a1af1ef26a56?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Theresa Webb',
		title: 'Global Division Officer',
		role: 'Admin',
		email: 'theresawebb@example.com',
		telephone: '+1-202-555-0138',
		imageUrl:
			'https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
];

const people2 = [
	{
		name: 'Jane Cooper',
		title: 'Regional Paradigm Technician',
		role: 'Admin',
		email: 'janecooper@example.com',
		telephone: '+1-202-555-0170',
		imageUrl:
			'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Cody Fisher',
		title: 'Product Directives Officer',
		role: 'Admin',
		email: 'codyfisher@example.com',
		telephone: '+1-202-555-0114',
		imageUrl:
			'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Esther Howard',
		title: 'Forward Response Developer',
		email: 'estherhoward@example.com',
		telephone: '+1-202-555-0143',
		role: 'Admin',
		imageUrl:
			'https://images.unsplash.com/photo-1520813792240-56fc4a3765a7?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Jenny Wilson',
		title: 'Central Security Manager',
		role: 'Admin',
		email: 'jennywilson@example.com',
		telephone: '+1-202-555-0184',
		imageUrl:
			'https://images.unsplash.com/photo-1498551172505-8ee7ad69f235?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Kristin Watson',
		title: 'Lead Implementation Liaison',
		role: 'Admin',
		email: 'kristinwatson@example.com',
		telephone: '+1-202-555-0191',
		imageUrl:
			'https://images.unsplash.com/photo-1532417344469-368f9ae6d187?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
	{
		name: 'Cameron Williamson',
		title: 'Internal Applications Engineer',
		role: 'Admin',
		email: 'cameronwilliamson@example.com',
		telephone: '+1-202-555-0108',
		imageUrl:
			'https://images.unsplash.com/photo-1566492031773-4f4e44671857?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
	},
];

function MailIcon({ class: className }: { class?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			class={className}
		>
			<rect width="20" height="16" x="2" y="4" rx="2" />
			<path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
		</svg>
	);
}

function PhoneIcon({ class: className }: { class?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			class={className}
		>
			<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
		</svg>
	);
}

export function GridListsDemo() {
	return (
		<div class="space-y-8">
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">
					Contact cards with small portrait
				</h3>
				<ul role="list" class="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
					{people.map((person) => (
						<li
							key={person.email}
							class="col-span-1 flex flex-col divide-y divide-surface-2 rounded-lg bg-surface-0 text-center shadow-sm dark:divide-white/10 dark:bg-surface-0/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10"
						>
							<div class="flex flex-1 flex-col p-8">
								<img
									alt=""
									src={person.imageUrl}
									class="mx-auto size-32 shrink-0 rounded-full bg-surface-3 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
								/>
								<h3 class="mt-6 text-sm font-medium text-text-primary">{person.name}</h3>
								<dl class="mt-1 flex grow flex-col justify-between">
									<dt class="sr-only">Title</dt>
									<dd class="text-sm text-text-secondary">{person.title}</dd>
									<dt class="sr-only">Role</dt>
									<dd class="mt-3">
										<span class="inline-flex items-center rounded-full bg-green-500/10 px-2 py-1 text-xs font-medium text-green-500 inset-ring inset-ring-green-500/10 dark:bg-green-500/10 dark:text-green-500 dark:inset-ring-green-500/10">
											{person.role}
										</span>
									</dd>
								</dl>
							</div>
							<div>
								<div class="-mt-px flex divide-x divide-surface-2 dark:divide-white/10">
									<div class="flex w-0 flex-1">
										<a
											href={`mailto:${person.email}`}
											class="relative -mr-px inline-flex w-0 flex-1 items-center justify-center gap-x-3 rounded-bl-lg border border-transparent py-4 text-sm font-semibold text-text-primary"
										>
											<MailIcon
												aria-hidden="true"
												class="size-5 text-text-tertiary dark:text-text-secondary"
											/>
											Email
										</a>
									</div>
									<div class="-ml-px flex w-0 flex-1">
										<a
											href={`tel:${person.telephone}`}
											class="relative inline-flex w-0 flex-1 items-center justify-center gap-x-3 rounded-br-lg border border-transparent py-4 text-sm font-semibold text-text-primary"
										>
											<PhoneIcon
												aria-hidden="true"
												class="size-5 text-text-tertiary dark:text-text-secondary"
											/>
											Call
										</a>
									</div>
								</div>
							</div>
						</li>
					))}
				</ul>
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Contact cards</h3>
				<ul role="list" class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
					{people2.map((person) => (
						<li
							key={person.email}
							class="col-span-1 divide-y divide-surface-2 rounded-lg bg-surface-0 shadow-sm dark:divide-white/10 dark:bg-surface-0/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10"
						>
							<div class="flex w-full items-center justify-between space-x-6 p-6">
								<div class="flex-1 truncate">
									<div class="flex items-center space-x-3">
										<h3 class="truncate text-sm font-medium text-text-primary">{person.name}</h3>
										<span class="inline-flex shrink-0 items-center rounded-full bg-green-500/10 px-1.5 py-0.5 text-xs font-medium text-green-500 inset-ring inset-ring-green-500/10 dark:bg-green-500/10 dark:text-green-500 dark:inset-ring-green-500/10">
											{person.role}
										</span>
									</div>
									<p class="mt-1 truncate text-sm text-text-secondary">{person.title}</p>
								</div>
								<img
									alt=""
									src={person.imageUrl}
									class="size-10 shrink-0 rounded-full bg-surface-3 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
								/>
							</div>
							<div>
								<div class="-mt-px flex divide-x divide-surface-2 dark:divide-white/10">
									<div class="flex w-0 flex-1">
										<a
											href={`mailto:${person.email}`}
											class="relative -mr-px inline-flex w-0 flex-1 items-center justify-center gap-x-3 rounded-bl-lg border border-transparent py-4 text-sm font-semibold text-text-primary"
										>
											<MailIcon
												aria-hidden="true"
												class="size-5 text-text-tertiary dark:text-text-secondary"
											/>
											Email
										</a>
									</div>
									<div class="-ml-px flex w-0 flex-1">
										<a
											href={`tel:${person.telephone}`}
											class="relative inline-flex w-0 flex-1 items-center justify-center gap-x-3 rounded-br-lg border border-transparent py-4 text-sm font-semibold text-text-primary"
										>
											<PhoneIcon
												aria-hidden="true"
												class="size-5 text-text-tertiary dark:text-text-secondary"
											/>
											Call
										</a>
									</div>
								</div>
							</div>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}
