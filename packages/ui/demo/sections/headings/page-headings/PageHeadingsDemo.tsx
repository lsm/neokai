import { EllipsisVertical, Pencil } from 'lucide-preact';

export function PageHeadingsDemo() {
	return (
		<div class="space-y-12">
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">With actions</h3>
				<div class="md:flex md:items-center md:justify-between">
					<div class="min-w-0 flex-1">
						<h2 class="text-2xl/7 font-bold text-gray-900 sm:truncate sm:text-3xl sm:tracking-tight dark:text-white">
							Back End Developer
						</h2>
					</div>
					<div class="mt-4 flex md:mt-0 md:ml-4">
						<button
							type="button"
							class="inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
						>
							Edit
						</button>
						<button
							type="button"
							class="ml-3 inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-400"
						>
							Publish
						</button>
					</div>
				</div>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">With actions and breadcrumbs</h3>
				<div>
					<div>
						<nav aria-label="Back" class="sm:hidden">
							<a
								href="#"
								class="flex items-center text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
							>
								<svg
									viewBox="0 0 20 20"
									fill="currentColor"
									aria-hidden="true"
									class="mr-1 -ml-1 size-5 shrink-0 text-gray-400 dark:text-gray-500"
								>
									<path
										d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"
										clip-rule="evenodd"
										fill-rule="evenodd"
									/>
								</svg>
								Back
							</a>
						</nav>
						<nav aria-label="Breadcrumb" class="hidden sm:flex">
							<ol role="list" class="flex items-center space-x-4">
								<li>
									<div class="flex">
										<a
											href="#"
											class="text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
										>
											Jobs
										</a>
									</div>
								</li>
								<li>
									<div class="flex items-center">
										<svg
											viewBox="0 0 20 20"
											fill="currentColor"
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										>
											<path
												d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z"
												clip-rule="evenodd"
												fill-rule="evenodd"
											/>
										</svg>
										<a
											href="#"
											class="ml-4 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
										>
											Engineering
										</a>
									</div>
								</li>
								<li>
									<div class="flex items-center">
										<svg
											viewBox="0 0 20 20"
											fill="currentColor"
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										>
											<path
												d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z"
												clip-rule="evenodd"
												fill-rule="evenodd"
											/>
										</svg>
										<a
											href="#"
											aria-current="page"
											class="ml-4 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
										>
											Back End Developer
										</a>
									</div>
								</li>
							</ol>
						</nav>
					</div>
					<div class="mt-2 md:flex md:items-center md:justify-between">
						<div class="min-w-0 flex-1">
							<h2 class="text-2xl/7 font-bold text-gray-900 sm:truncate sm:text-3xl sm:tracking-tight dark:text-white">
								Back End Developer
							</h2>
						</div>
						<div class="mt-4 flex shrink-0 md:mt-0 md:ml-4">
							<button
								type="button"
								class="inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
							>
								Edit
							</button>
							<button
								type="button"
								class="ml-3 inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
							>
								Publish
							</button>
						</div>
					</div>
				</div>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">With tabs</h3>
				<div class="relative border-b border-gray-200 pb-5 sm:pb-0 dark:border-white/10">
					<div class="md:flex md:items-center md:justify-between">
						<h3 class="text-base font-semibold text-gray-900 dark:text-white">Candidates</h3>
						<div class="mt-3 flex md:absolute md:top-3 md:right-0 md:mt-0">
							<button
								type="button"
								class="inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
							>
								Share
							</button>
							<button
								type="button"
								class="ml-3 inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
							>
								Create
							</button>
						</div>
					</div>
					<div class="mt-4">
						<div class="grid grid-cols-1 sm:hidden">
							<select
								aria-label="Select a tab"
								class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white py-2 pr-8 pl-3 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-white/5 dark:text-white dark:outline-white/10"
							>
								<option>Applied</option>
								<option>Phone Screening</option>
								<option selected>Interview</option>
								<option>Offer</option>
								<option>Hired</option>
							</select>
							<svg
								viewBox="0 0 16 16"
								fill="currentColor"
								aria-hidden="true"
								class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-gray-500 dark:fill-gray-400"
							>
								<path
									d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
									clip-rule="evenodd"
									fill-rule="evenodd"
								/>
							</svg>
						</div>
						<div class="hidden sm:block">
							<nav class="-mb-px flex space-x-8">
								<a
									href="#"
									class="border-b-2 border-transparent px-1 pb-4 text-sm font-medium whitespace-nowrap text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white"
								>
									Applied
								</a>
								<a
									href="#"
									class="border-b-2 border-transparent px-1 pb-4 text-sm font-medium whitespace-nowrap text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white"
								>
									Phone Screening
								</a>
								<a
									href="#"
									aria-current="page"
									class="border-b-2 border-indigo-500 px-1 pb-4 text-sm font-medium whitespace-nowrap text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
								>
									Interview
								</a>
								<a
									href="#"
									class="border-b-2 border-transparent px-1 pb-4 text-sm font-medium whitespace-nowrap text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white"
								>
									Offer
								</a>
								<a
									href="#"
									class="border-b-2 border-transparent px-1 pb-4 text-sm font-medium whitespace-nowrap text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white"
								>
									Hired
								</a>
							</nav>
						</div>
					</div>
				</div>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">With icon-only actions</h3>
				<div class="md:flex md:items-center md:justify-between">
					<div class="min-w-0 flex-1">
						<h2 class="text-2xl/7 font-bold text-gray-900 sm:truncate sm:text-3xl sm:tracking-tight dark:text-white">
							Projects
						</h2>
					</div>
					<div class="mt-4 flex md:mt-0 md:ml-4">
						<button
							type="button"
							class="rounded-full bg-white p-2 text-gray-400 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
						>
							<span class="sr-only">Edit</span>
							<Pencil class="size-5" />
						</button>
						<button
							type="button"
							class="ml-2 rounded-full bg-white p-2 text-gray-400 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
						>
							<span class="sr-only">More options</span>
							<EllipsisVertical class="size-5" />
						</button>
					</div>
				</div>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">
					With icon-only actions and filters
				</h3>
				<div class="md:flex md:items-center md:justify-between">
					<div class="min-w-0 flex-1">
						<h2 class="text-2xl/7 font-bold text-gray-900 sm:truncate sm:text-3xl sm:tracking-tight dark:text-white">
							Team Members
						</h2>
					</div>
					<div class="mt-4 flex gap-2 md:mt-0 md:ml-4">
						<button
							type="button"
							class="rounded-full bg-white p-2 text-gray-400 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
						>
							<span class="sr-only">Filter</span>
							<svg viewBox="0 0 20 20" fill="currentColor" class="size-5">
								<path
									fill-rule="evenodd"
									d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 01.628.74v2.288a2.25 2.25 0 01-.659 1.59l-4.682 4.683a2.25 2.25 0 00-.659 1.59v3.037c0 .684-.31 1.33-.844 1.757l-1.937 1.55A.75.75 0 0113.278 18H6.722a.75.75 0 01-.593-.74c-.05-.057-.1-.115-.148-.173a1.06 1.06 0 00-.147-.173l-1.937-1.55A2.75 2.75 0 011.5 13.307V10.72a2.25 2.25 0 00-.659-1.591L.659 4.428A.75.75 0 011.001 3.137v-.537z"
									clip-rule="evenodd"
								/>
							</svg>
						</button>
						<button
							type="button"
							class="rounded-full bg-white p-2 text-gray-400 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
						>
							<span class="sr-only">More options</span>
							<EllipsisVertical class="size-5" />
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
