export function SimpleProgressBars() {
	const steps = [
		{ id: 'Step 1', name: 'Job details', href: '#', status: 'complete' },
		{ id: 'Step 2', name: 'Application form', href: '#', status: 'current' },
		{ id: 'Step 3', name: 'Preview', href: '#', status: 'upcoming' },
	];

	return (
		<nav aria-label="Progress">
			<ol role="list" class="space-y-4 md:flex md:space-y-0 md:space-x-8">
				{steps.map((step) => (
					<li key={step.name} class="md:flex-1">
						{step.status === 'complete' ? (
							<a
								href={step.href}
								class="group flex flex-col border-l-4 border-accent-500 py-2 pl-4 hover:border-accent-600 md:border-t-4 md:border-l-0 md:pt-4 md:pb-0 md:pl-0"
							>
								<span class="text-sm font-medium text-accent-500 group-hover:text-accent-600">
									{step.id}
								</span>
								<span class="text-sm font-medium text-text-primary">{step.name}</span>
							</a>
						) : step.status === 'current' ? (
							<a
								href={step.href}
								aria-current="step"
								class="flex flex-col border-l-4 border-accent-500 py-2 pl-4 md:border-t-4 md:border-l-0 md:pt-4 md:pb-0 md:pl-0"
							>
								<span class="text-sm font-medium text-accent-500">{step.id}</span>
								<span class="text-sm font-medium text-text-primary">{step.name}</span>
							</a>
						) : (
							<a
								href={step.href}
								class="group flex flex-col border-l-4 border-surface-2 py-2 pl-4 hover:border-surface-border md:border-t-4 md:border-l-0 md:pt-4 md:pb-0 md:pl-0"
							>
								<span class="text-sm font-medium text-text-secondary group-hover:text-text-primary">
									{step.id}
								</span>
								<span class="text-sm font-medium text-text-primary">{step.name}</span>
							</a>
						)}
					</li>
				))}
			</ol>
		</nav>
	);
}

export function PanelProgressBars() {
	const steps = [
		{ id: '01', name: 'Job details', href: '#', status: 'complete' },
		{ id: '02', name: 'Application form', href: '#', status: 'current' },
		{ id: '03', name: 'Preview', href: '#', status: 'upcoming' },
	];

	return (
		<nav aria-label="Progress">
			<ol
				role="list"
				class="divide-y divide-surface-border rounded-md border border-surface-border md:flex md:divide-y-0"
			>
				{steps.map((step, stepIdx) => (
					<li key={step.name} class="relative md:flex md:flex-1">
						{step.status === 'complete' ? (
							<a href={step.href} class="group flex w-full items-center">
								<span class="flex items-center px-6 py-4 text-sm font-medium">
									<span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-500 group-hover:bg-accent-600">
										<svg
											aria-hidden="true"
											class="size-6 text-white"
											fill="currentColor"
											viewBox="0 0 20 20"
										>
											<path
												fill-rule="evenodd"
												d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
												clip-rule="evenodd"
											/>
										</svg>
									</span>
									<span class="ml-4 text-sm font-medium text-text-primary">{step.name}</span>
								</span>
							</a>
						) : step.status === 'current' ? (
							<a
								href={step.href}
								aria-current="step"
								class="flex items-center px-6 py-4 text-sm font-medium"
							>
								<span class="flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-accent-500">
									<span class="text-accent-500">{step.id}</span>
								</span>
								<span class="ml-4 text-sm font-medium text-accent-500">{step.name}</span>
							</a>
						) : (
							<a href={step.href} class="group flex items-center">
								<span class="flex items-center px-6 py-4 text-sm font-medium">
									<span class="flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-surface-border group-hover:border-surface-border/80">
										<span class="text-text-secondary group-hover:text-text-primary">{step.id}</span>
									</span>
									<span class="ml-4 text-sm font-medium text-text-secondary group-hover:text-text-primary">
										{step.name}
									</span>
								</span>
							</a>
						)}

						{stepIdx !== steps.length - 1 ? (
							<div aria-hidden="true" class="absolute top-0 right-0 hidden h-full w-5 md:block">
								<svg
									fill="none"
									viewBox="0 0 22 80"
									preserveAspectRatio="none"
									class="size-full text-surface-border"
								>
									<path
										d="M0 -2L20 40L0 82"
										stroke="currentColor"
										vector-effect="non-scaling-stroke"
										stroke-linejoin="round"
									/>
								</svg>
							</div>
						) : null}
					</li>
				))}
			</ol>
		</nav>
	);
}

export function BulletProgressBars() {
	const steps = [
		{ name: 'Step 1', href: '#', status: 'complete' },
		{ name: 'Step 2', href: '#', status: 'current' },
		{ name: 'Step 3', href: '#', status: 'upcoming' },
		{ name: 'Step 4', href: '#', status: 'upcoming' },
	];

	return (
		<nav aria-label="Progress" class="flex items-center justify-center">
			<p class="text-sm font-medium text-text-primary">
				Step {steps.findIndex((step) => step.status === 'current') + 1} of {steps.length}
			</p>
			<ol role="list" class="ml-8 flex items-center space-x-5">
				{steps.map((step) => (
					<li key={step.name}>
						{step.status === 'complete' ? (
							<a
								href={step.href}
								class="block size-2.5 rounded-full bg-accent-500 hover:bg-accent-600"
							>
								<span class="sr-only">{step.name}</span>
							</a>
						) : step.status === 'current' ? (
							<a
								href={step.href}
								aria-current="step"
								class="relative flex items-center justify-center"
							>
								<span aria-hidden="true" class="absolute flex size-5 p-px">
									<span class="size-full rounded-full bg-accent-900/20" />
								</span>
								<span
									aria-hidden="true"
									class="relative block size-2.5 rounded-full bg-accent-500"
								/>
								<span class="sr-only">{step.name}</span>
							</a>
						) : (
							<a
								href={step.href}
								class="block size-2.5 rounded-full bg-surface-2 hover:bg-surface-border"
							>
								<span class="sr-only">{step.name}</span>
							</a>
						)}
					</li>
				))}
			</ol>
		</nav>
	);
}

export function ProgressBarsDemo() {
	return (
		<div class="space-y-12">
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Simple Steps</h3>
				<SimpleProgressBars />
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Panels</h3>
				<PanelProgressBars />
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Bullets</h3>
				<BulletProgressBars />
			</div>
		</div>
	);
}
