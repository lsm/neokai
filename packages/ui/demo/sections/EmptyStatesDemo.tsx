export function EmptyStatesDemo() {
	return (
		<div class="text-center">
			<svg
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
				aria-hidden="true"
				class="mx-auto size-12 text-text-tertiary dark:text-text-secondary"
			>
				<path
					d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
					strokeWidth={2}
					vectorEffect="non-scaling-stroke"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
			<h3 class="mt-2 text-sm font-semibold text-text-primary dark:text-white">No projects</h3>
			<p class="mt-1 text-sm text-text-secondary dark:text-text-secondary">
				Get started by creating a new project.
			</p>
			<div class="mt-6">
				<button
					type="button"
					class="inline-flex items-center rounded-md bg-accent-500 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 dark:bg-accent-500 dark:shadow-none dark:hover:bg-accent-400 dark:focus-visible:outline-accent-400"
				>
					<svg
						aria-hidden="true"
						class="mr-1.5 -ml-0.5 size-5"
						fill="currentColor"
						viewBox="0 0 20 20"
					>
						<path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
					</svg>
					New Project
				</button>
			</div>
		</div>
	);
}
