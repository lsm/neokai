export function CardHeadingsDemo() {
	return (
		<div class="space-y-12">
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">Simple</h3>
				<div class="border-b border-gray-200 px-4 py-5 sm:px-6 dark:border-white/10">
					<h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
				</div>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">With action</h3>
				<div class="border-b border-gray-200 px-4 py-5 sm:px-6 dark:border-white/10">
					<div class="-mt-2 -ml-4 flex flex-wrap items-center justify-between sm:flex-nowrap">
						<div class="mt-2 ml-4">
							<h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
						</div>
						<div class="mt-2 ml-4 shrink-0">
							<button
								type="button"
								class="relative inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
							>
								Create new job
							</button>
						</div>
					</div>
				</div>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">With avatar and actions</h3>
				<div class="border-b border-gray-200 dark:border-white/10">
					<div class="sm:flex sm:items-baseline">
						<h3 class="text-base font-semibold text-gray-900 dark:text-white">Issues</h3>
						<div class="mt-4 sm:mt-0 sm:ml-10">
							<nav class="-mb-px flex space-x-8">
								<a
									href="#"
									aria-current="page"
									class="border-b-2 border-indigo-500 px-1 pb-4 text-sm font-medium whitespace-nowrap text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
								>
									Open
								</a>
								<a
									href="#"
									class="border-b-2 border-transparent px-1 pb-4 text-sm font-medium whitespace-nowrap text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white"
								>
									Closed
								</a>
							</nav>
						</div>
					</div>
				</div>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">With description</h3>
				<div class="border-b border-gray-200 pb-5 dark:border-white/10">
					<h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
					<p class="mt-2 max-w-4xl text-sm text-gray-500 dark:text-gray-400">
						Workcation is a property rental website. Etiam ullamcorper massa viverra consequat,
						consectetur id nulla tempus. Fringilla egestas justo massa purus sagittis malesuada.
					</p>
				</div>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">With description and action</h3>
				<div class="border-b border-gray-200 pb-5 dark:border-white/10">
					<div class="sm:flex sm:items-center sm:justify-between">
						<h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
						<div class="mt-3 sm:mt-0 sm:ml-4">
							<button
								type="button"
								class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
							>
								Create new job
							</button>
						</div>
					</div>
				</div>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">With avatar, meta, and dropdown</h3>
				<div class="border-b border-gray-200 dark:border-white/10">
					<div class="sm:flex sm:items-baseline sm:justify-between">
						<div class="sm:w-0 sm:flex-1">
							<h1
								id="message-heading"
								class="text-base font-semibold text-gray-900 dark:text-white"
							>
								Full-Stack Developer
							</h1>
							<p class="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
								Checkout and Payments Team
							</p>
						</div>
						<div class="mt-4 flex items-center justify-between sm:mt-0 sm:ml-6 sm:shrink-0 sm:justify-start">
							<span class="inline-flex items-center rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-700 inset-ring inset-ring-green-600/20 dark:bg-green-500/10 dark:text-green-400 dark:inset-ring-green-500/10">
								Open
							</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
