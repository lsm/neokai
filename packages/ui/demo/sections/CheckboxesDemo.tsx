export function CheckboxesDemo() {
	return (
		<div class="space-y-6">
			{/* Example 1: List with description */}
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">List with description</h3>
				<fieldset class="space-y-4">
					<legend class="sr-only">Notifications</legend>
					<div class="relative flex items-start gap-3">
						<div class="grid size-5 grid-cols-1 place-content-center">
							<input
								id="comments"
								name="comments"
								type="checkbox"
								class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
							/>
							<svg
								class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
								viewBox="0 0 14 14"
								fill="none"
							>
								<path
									d="M3 7l3 3 5-5"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</div>
						<div class="min-w-0 flex-1">
							<label for="comments" class="text-sm font-medium text-gray-900 dark:text-white">
								New comments
							</label>
							<p id="comments-description" class="text-xs text-gray-500 dark:text-gray-400">
								Get notified when someones posts a comment on a posting.
							</p>
						</div>
					</div>
					<div class="relative flex items-start gap-3">
						<div class="grid size-5 grid-cols-1 place-content-center">
							<input
								id="candidates"
								name="candidates"
								type="checkbox"
								class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
							/>
							<svg
								class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
								viewBox="0 0 14 14"
								fill="none"
							>
								<path
									d="M3 7l3 3 5-5"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</div>
						<div class="min-w-0 flex-1">
							<label for="candidates" class="text-sm font-medium text-gray-900 dark:text-white">
								New candidates
							</label>
							<p id="candidates-description" class="text-xs text-gray-500 dark:text-gray-400">
								Get notified when a candidate applies for a job.
							</p>
						</div>
					</div>
					<div class="relative flex items-start gap-3">
						<div class="grid size-5 grid-cols-1 place-content-center">
							<input
								id="offers"
								name="offers"
								type="checkbox"
								class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
							/>
							<svg
								class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
								viewBox="0 0 14 14"
								fill="none"
							>
								<path
									d="M3 7l3 3 5-5"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</div>
						<div class="min-w-0 flex-1">
							<label for="offers" class="text-sm font-medium text-gray-900 dark:text-white">
								Offers
							</label>
							<p id="offers-description" class="text-xs text-gray-500 dark:text-gray-400">
								Get notified when a candidate accepts or rejects an offer.
							</p>
						</div>
					</div>
				</fieldset>
			</div>

			{/* Example 2: List with inline description */}
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">List with inline description</h3>
				<fieldset class="space-y-0 divide-y divide-gray-200 dark:divide-white/10">
					<legend class="sr-only">Notifications</legend>
					<div class="relative flex items-start gap-3 py-4 first:pt-0 last:pb-0">
						<div class="grid size-5 grid-cols-1 place-content-center">
							<input
								id="comments-inline"
								name="comments-inline"
								type="checkbox"
								class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
							/>
							<svg
								class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
								viewBox="0 0 14 14"
								fill="none"
							>
								<path
									d="M3 7l3 3 5-5"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</div>
						<div class="min-w-0 flex-1">
							<label
								for="comments-inline"
								class="text-sm font-medium text-gray-900 dark:text-white"
							>
								New comments
							</label>
							<p id="comments-inline-description" class="text-xs text-gray-500 dark:text-gray-400">
								Get notified when someones posts a comment on a posting.
							</p>
						</div>
					</div>
					<div class="relative flex items-start gap-3 py-4 first:pt-0 last:pb-0">
						<div class="grid size-5 grid-cols-1 place-content-center">
							<input
								id="candidates-inline"
								name="candidates-inline"
								type="checkbox"
								class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
							/>
							<svg
								class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
								viewBox="0 0 14 14"
								fill="none"
							>
								<path
									d="M3 7l3 3 5-5"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</div>
						<div class="min-w-0 flex-1">
							<label
								for="candidates-inline"
								class="text-sm font-medium text-gray-900 dark:text-white"
							>
								New candidates
							</label>
							<p
								id="candidates-inline-description"
								class="text-xs text-gray-500 dark:text-gray-400"
							>
								Get notified when a candidate applies for a job.
							</p>
						</div>
					</div>
					<div class="relative flex items-start gap-3 py-4 first:pt-0 last:pb-0">
						<div class="grid size-5 grid-cols-1 place-content-center">
							<input
								id="offers-inline"
								name="offers-inline"
								type="checkbox"
								class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
							/>
							<svg
								class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
								viewBox="0 0 14 14"
								fill="none"
							>
								<path
									d="M3 7l3 3 5-5"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</div>
						<div class="min-w-0 flex-1">
							<label for="offers-inline" class="text-sm font-medium text-gray-900 dark:text-white">
								Offers
							</label>
							<p id="offers-inline-description" class="text-xs text-gray-500 dark:text-gray-400">
								Get notified when a candidate accepts or rejects an offer.
							</p>
						</div>
					</div>
				</fieldset>
			</div>

			{/* Example 3: List with checkbox on right */}
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">List with checkbox on right</h3>
				<fieldset class="space-y-0 divide-y divide-gray-200 dark:divide-white/10">
					<legend class="sr-only">Notifications</legend>
					<div class="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-6">
						<label
							for="comments-right"
							class="text-sm font-medium text-gray-900 dark:text-white min-w-32"
						>
							New comments
						</label>
						<div class="flex flex-1 items-center justify-between">
							<p id="comments-right-description" class="text-xs text-gray-500 dark:text-gray-400">
								Get notified when someones posts a comment on a posting.
							</p>
							<div class="grid size-5 grid-cols-1 place-content-center">
								<input
									id="comments-right"
									name="comments-right"
									type="checkbox"
									aria-describedby="comments-right-description"
									class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
								/>
								<svg
									class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
									viewBox="0 0 14 14"
									fill="none"
								>
									<path
										d="M3 7l3 3 5-5"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</div>
						</div>
					</div>
					<div class="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-6">
						<label
							for="candidates-right"
							class="text-sm font-medium text-gray-900 dark:text-white min-w-32"
						>
							New candidates
						</label>
						<div class="flex flex-1 items-center justify-between">
							<p id="candidates-right-description" class="text-xs text-gray-500 dark:text-gray-400">
								Get notified when a candidate applies for a job.
							</p>
							<div class="grid size-5 grid-cols-1 place-content-center">
								<input
									id="candidates-right"
									name="candidates-right"
									type="checkbox"
									aria-describedby="candidates-right-description"
									class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
								/>
								<svg
									class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
									viewBox="0 0 14 14"
									fill="none"
								>
									<path
										d="M3 7l3 3 5-5"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</div>
						</div>
					</div>
					<div class="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-6">
						<label
							for="offers-right"
							class="text-sm font-medium text-gray-900 dark:text-white min-w-32"
						>
							Offers
						</label>
						<div class="flex flex-1 items-center justify-between">
							<p id="offers-right-description" class="text-xs text-gray-500 dark:text-gray-400">
								Get notified when a candidate accepts or rejects an offer.
							</p>
							<div class="grid size-5 grid-cols-1 place-content-center">
								<input
									id="offers-right"
									name="offers-right"
									type="checkbox"
									aria-describedby="offers-right-description"
									class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
								/>
								<svg
									class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
									viewBox="0 0 14 14"
									fill="none"
								>
									<path
										d="M3 7l3 3 5-5"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</div>
						</div>
					</div>
				</fieldset>
			</div>

			{/* Example 4: Simple list with heading */}
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Simple list with heading</h3>
				<fieldset class="space-y-4">
					<legend class="text-sm font-medium text-gray-900 dark:text-white">Members</legend>
					<div class="relative flex items-start gap-3">
						<div class="grid size-5 grid-cols-1 place-content-center">
							<input
								id="member-1"
								name="member-1"
								type="checkbox"
								class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
							/>
							<svg
								class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
								viewBox="0 0 14 14"
								fill="none"
							>
								<path
									d="M3 7l3 3 5-5"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</div>
						<label for="member-1" class="text-sm text-gray-700 dark:text-gray-300">
							Alex Ferguson
						</label>
					</div>
					<div class="relative flex items-start gap-3">
						<div class="grid size-5 grid-cols-1 place-content-center">
							<input
								id="member-2"
								name="member-2"
								type="checkbox"
								class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
							/>
							<svg
								class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
								viewBox="0 0 14 14"
								fill="none"
							>
								<path
									d="M3 7l3 3 5-5"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</div>
						<label for="member-2" class="text-sm text-gray-700 dark:text-gray-300">
							José Mourinho
						</label>
					</div>
					<div class="relative flex items-start gap-3">
						<div class="grid size-5 grid-cols-1 place-content-center">
							<input
								id="member-3"
								name="member-3"
								type="checkbox"
								class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
							/>
							<svg
								class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
								viewBox="0 0 14 14"
								fill="none"
							>
								<path
									d="M3 7l3 3 5-5"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</div>
						<label for="member-3" class="text-sm text-gray-700 dark:text-gray-300">
							Arsène Wenger
						</label>
					</div>
					<div class="relative flex items-start gap-3">
						<div class="grid size-5 grid-cols-1 place-content-center">
							<input
								id="member-4"
								name="member-4"
								type="checkbox"
								class="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto"
							/>
							<svg
								class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-gray-950/25 dark:group-has-disabled:stroke-white/25 hidden opacity-0 [[data[checked]_&]:opacity-100] [[data[indeterminate]_&]:opacity-100]"
								viewBox="0 0 14 14"
								fill="none"
							>
								<path
									d="M3 7l3 3 5-5"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</div>
						<label for="member-4" class="text-sm text-gray-700 dark:text-gray-300">
							Diana Ross
						</label>
					</div>
				</fieldset>
			</div>
		</div>
	);
}
