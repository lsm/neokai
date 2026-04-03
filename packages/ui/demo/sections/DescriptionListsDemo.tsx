import { Paperclip } from 'lucide-preact';

function LeftAligned() {
	return (
		<div>
			<div class="px-4 sm:px-0">
				<h3 class="text-base/7 font-semibold text-gray-900 dark:text-white">
					Applicant Information
				</h3>
				<p class="mt-1 max-w-2xl text-sm/6 text-gray-500 dark:text-gray-400">
					Personal details and application.
				</p>
			</div>
			<div class="mt-6 border-t border-gray-100 dark:border-white/10">
				<dl class="divide-y divide-gray-100 dark:divide-white/10">
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Full name</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							Margot Foster
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Application for</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							Backend Developer
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Email address</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							margotfoster@example.com
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Salary expectation</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							$120,000
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">About</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							Fugiat ipsum ipsum deserunt culpa aute sint do nostrud anim incididunt cillum culpa
							consequat. Excepteur qui ipsum aliquip consequat sint. Sit id mollit nulla mollit
							nostrud in ea officia proident. Irure nostrud pariatur mollit ad adipisicing
							reprehenderit deserunt qui eu.
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Attachments</dt>
						<dd class="mt-2 text-sm text-gray-900 sm:col-span-2 sm:mt-0 dark:text-white">
							<ul
								role="list"
								class="divide-y divide-gray-100 rounded-md border border-gray-200 dark:divide-white/5 dark:border-white/10"
							>
								<li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
									<div class="flex w-0 flex-1 items-center">
										<Paperclip
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										/>
										<div class="ml-4 flex min-w-0 flex-1 gap-2">
											<span class="truncate font-medium text-gray-900 dark:text-white">
												resume_back_end_developer.pdf
											</span>
											<span class="shrink-0 text-gray-400 dark:text-gray-500">2.4mb</span>
										</div>
									</div>
									<div class="ml-4 shrink-0">
										<a
											href="#"
											class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
										>
											Download
										</a>
									</div>
								</li>
								<li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
									<div class="flex w-0 flex-1 items-center">
										<Paperclip
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										/>
										<div class="ml-4 flex min-w-0 flex-1 gap-2">
											<span class="truncate font-medium text-gray-900 dark:text-white">
												coverletter_back_end_developer.pdf
											</span>
											<span class="shrink-0 text-gray-400 dark:text-gray-500">4.5mb</span>
										</div>
									</div>
									<div class="ml-4 shrink-0">
										<a
											href="#"
											class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
										>
											Download
										</a>
									</div>
								</li>
							</ul>
						</dd>
					</div>
				</dl>
			</div>
		</div>
	);
}

function TwoColumn() {
	return (
		<div>
			<div class="px-4 sm:px-0">
				<h3 class="text-base/7 font-semibold text-gray-900 dark:text-white">
					Applicant Information
				</h3>
				<p class="mt-1 max-w-2xl text-sm/6 text-gray-500 dark:text-gray-400">
					Personal details and application.
				</p>
			</div>
			<div class="mt-6">
				<dl class="grid grid-cols-1 sm:grid-cols-2">
					<div class="border-t border-gray-100 px-4 py-6 sm:col-span-1 sm:px-0 dark:border-white/10">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Full name</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:mt-2 dark:text-gray-400">Margot Foster</dd>
					</div>
					<div class="border-t border-gray-100 px-4 py-6 sm:col-span-1 sm:px-0 dark:border-white/10">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Application for</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:mt-2 dark:text-gray-400">
							Backend Developer
						</dd>
					</div>
					<div class="border-t border-gray-100 px-4 py-6 sm:col-span-1 sm:px-0 dark:border-white/10">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Email address</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:mt-2 dark:text-gray-400">
							margotfoster@example.com
						</dd>
					</div>
					<div class="border-t border-gray-100 px-4 py-6 sm:col-span-1 sm:px-0 dark:border-white/10">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Salary expectation</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:mt-2 dark:text-gray-400">$120,000</dd>
					</div>
					<div class="border-t border-gray-100 px-4 py-6 sm:col-span-2 sm:px-0 dark:border-white/10">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">About</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:mt-2 dark:text-gray-400">
							Fugiat ipsum ipsum deserunt culpa aute sint do nostrud anim incididunt cillum culpa
							consequat. Excepteur qui ipsum aliquip consequat sint. Sit id mollit nulla mollit
							nostrud in ea officia proident. Irure nostrud pariatur mollit ad adipisicing
							reprehenderit deserunt qui eu.
						</dd>
					</div>
					<div class="border-t border-gray-100 px-4 py-6 sm:col-span-2 sm:px-0 dark:border-white/10">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Attachments</dt>
						<dd class="mt-2 text-sm text-gray-900 dark:text-white">
							<ul
								role="list"
								class="divide-y divide-gray-100 rounded-md border border-gray-200 dark:divide-white/5 dark:border-white/10"
							>
								<li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
									<div class="flex w-0 flex-1 items-center">
										<Paperclip
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										/>
										<div class="ml-4 flex min-w-0 flex-1 gap-2">
											<span class="truncate font-medium text-gray-900 dark:text-white">
												resume_back_end_developer.pdf
											</span>
											<span class="shrink-0 text-gray-400 dark:text-gray-500">2.4mb</span>
										</div>
									</div>
									<div class="ml-4 shrink-0">
										<a
											href="#"
											class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
										>
											Download
										</a>
									</div>
								</li>
								<li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
									<div class="flex w-0 flex-1 items-center">
										<Paperclip
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										/>
										<div class="ml-4 flex min-w-0 flex-1 gap-2">
											<span class="truncate font-medium text-gray-900 dark:text-white">
												coverletter_back_end_developer.pdf
											</span>
											<span class="shrink-0 text-gray-400 dark:text-gray-500">4.5mb</span>
										</div>
									</div>
									<div class="ml-4 shrink-0">
										<a
											href="#"
											class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
										>
											Download
										</a>
									</div>
								</li>
							</ul>
						</dd>
					</div>
				</dl>
			</div>
		</div>
	);
}

function LeftAlignedInCard() {
	return (
		<div class="overflow-hidden bg-white shadow-sm sm:rounded-lg dark:bg-gray-800/50 dark:shadow-none dark:inset-ring dark:inset-ring-white/10">
			<div class="px-4 py-6 sm:px-6">
				<h3 class="text-base/7 font-semibold text-gray-900 dark:text-white">
					Applicant Information
				</h3>
				<p class="mt-1 max-w-2xl text-sm/6 text-gray-500 dark:text-gray-300">
					Personal details and application.
				</p>
			</div>
			<div class="border-t border-gray-100 dark:border-white/5">
				<dl class="divide-y divide-gray-100 dark:divide-white/5">
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
						<dt class="text-sm font-medium text-gray-900 dark:text-gray-100">Full name</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-300">
							Margot Foster
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
						<dt class="text-sm font-medium text-gray-900 dark:text-gray-100">Application for</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-300">
							Backend Developer
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
						<dt class="text-sm font-medium text-gray-900 dark:text-gray-100">Email address</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-300">
							margotfoster@example.com
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
						<dt class="text-sm font-medium text-gray-900 dark:text-gray-100">Salary expectation</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-300">
							$120,000
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
						<dt class="text-sm font-medium text-gray-900 dark:text-gray-100">About</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-300">
							Fugiat ipsum ipsum deserunt culpa aute sint do nostrud anim incididunt cillum culpa
							consequat. Excepteur qui ipsum aliquip consequat sint. Sit id mollit nulla mollit
							nostrud in ea officia proident. Irure nostrud pariatur mollit ad adipisicing
							reprehenderit deserunt qui eu.
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-gray-100">Attachments</dt>
						<dd class="mt-2 text-sm text-gray-900 sm:col-span-2 sm:mt-0 dark:text-gray-100">
							<ul
								role="list"
								class="divide-y divide-gray-100 rounded-md border border-gray-200 dark:divide-white/5 dark:border-white/10"
							>
								<li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
									<div class="flex w-0 flex-1 items-center">
										<Paperclip
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										/>
										<div class="ml-4 flex min-w-0 flex-1 gap-2">
											<span class="truncate font-medium text-gray-900 dark:text-gray-100">
												resume_back_end_developer.pdf
											</span>
											<span class="shrink-0 text-gray-400 dark:text-gray-500">2.4mb</span>
										</div>
									</div>
									<div class="ml-4 shrink-0">
										<a
											href="#"
											class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
										>
											Download
										</a>
									</div>
								</li>
								<li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
									<div class="flex w-0 flex-1 items-center">
										<Paperclip
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										/>
										<div class="ml-4 flex min-w-0 flex-1 gap-2">
											<span class="truncate font-medium text-gray-900 dark:text-gray-100">
												coverletter_back_end_developer.pdf
											</span>
											<span class="shrink-0 text-gray-400 dark:text-gray-500">4.5mb</span>
										</div>
									</div>
									<div class="ml-4 shrink-0">
										<a
											href="#"
											class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
										>
											Download
										</a>
									</div>
								</li>
							</ul>
						</dd>
					</div>
				</dl>
			</div>
		</div>
	);
}

function LeftAlignedStriped() {
	return (
		<div>
			<div class="px-4 sm:px-0">
				<h3 class="text-base/7 font-semibold text-gray-900 dark:text-white">
					Applicant Information
				</h3>
				<p class="mt-1 max-w-2xl text-sm/6 text-gray-500 dark:text-gray-400">
					Personal details and application.
				</p>
			</div>
			<div class="mt-6 border-t border-gray-100 dark:border-white/5">
				<dl class="divide-y divide-gray-100 dark:divide-white/5">
					<div class="bg-gray-50 px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-gray-800/25">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Full name</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							Margot Foster
						</dd>
					</div>
					<div class="bg-white px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-gray-900">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Application for</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							Backend Developer
						</dd>
					</div>
					<div class="bg-gray-50 px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-gray-800/25">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Email address</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							margotfoster@example.com
						</dd>
					</div>
					<div class="bg-white px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-gray-900">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Salary expectation</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							$120,000
						</dd>
					</div>
					<div class="bg-gray-50 px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-gray-800/25">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">About</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							Fugiat ipsum ipsum deserunt culpa aute sint do nostrud anim incididunt cillum culpa
							consequat. Excepteur qui ipsum aliquip consequat sint. Sit id mollit nulla mollit
							nostrud in ea officia proident. Irure nostrud pariatur mollit ad adipisicing
							reprehenderit deserunt qui eu.
						</dd>
					</div>
					<div class="bg-white px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-gray-900">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Attachments</dt>
						<dd class="mt-2 text-sm text-gray-900 sm:col-span-2 sm:mt-0 dark:text-white">
							<ul
								role="list"
								class="divide-y divide-gray-100 rounded-md border border-gray-200 dark:divide-white/5 dark:border-white/10"
							>
								<li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
									<div class="flex w-0 flex-1 items-center">
										<Paperclip
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										/>
										<div class="ml-4 flex min-w-0 flex-1 gap-2">
											<span class="truncate font-medium text-gray-900 dark:text-white">
												resume_back_end_developer.pdf
											</span>
											<span class="shrink-0 text-gray-400 dark:text-gray-500">2.4mb</span>
										</div>
									</div>
									<div class="ml-4 shrink-0">
										<a
											href="#"
											class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
										>
											Download
										</a>
									</div>
								</li>
								<li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
									<div class="flex w-0 flex-1 items-center">
										<Paperclip
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										/>
										<div class="ml-4 flex min-w-0 flex-1 gap-2">
											<span class="truncate font-medium text-gray-900 dark:text-white">
												coverletter_back_end_developer.pdf
											</span>
											<span class="shrink-0 text-gray-400 dark:text-gray-500">4.5mb</span>
										</div>
									</div>
									<div class="ml-4 shrink-0">
										<a
											href="#"
											class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
										>
											Download
										</a>
									</div>
								</li>
							</ul>
						</dd>
					</div>
				</dl>
			</div>
		</div>
	);
}

function NarrowWithHiddenLabels() {
	return (
		<div>
			<div class="px-4 sm:px-0">
				<h3 class="text-base/7 font-semibold text-gray-900 dark:text-white">
					Applicant Information
				</h3>
				<p class="mt-1 max-w-2xl text-sm/6 text-gray-500 dark:text-gray-400">
					Personal details and application.
				</p>
			</div>
			<div class="mt-6 border-t border-gray-100 dark:border-white/10">
				<dl class="divide-y divide-gray-100 dark:divide-white/10">
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Full name</dt>
						<dd class="mt-1 flex text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							<span class="grow">Margot Foster</span>
							<span class="ml-4 shrink-0">
								<button
									type="button"
									class="rounded-md bg-white font-medium text-indigo-600 hover:text-indigo-500 dark:bg-transparent dark:text-indigo-400 dark:hover:text-indigo-300"
								>
									Update
								</button>
							</span>
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Application for</dt>
						<dd class="mt-1 flex text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							<span class="grow">Backend Developer</span>
							<span class="ml-4 shrink-0">
								<button
									type="button"
									class="rounded-md bg-white font-medium text-indigo-600 hover:text-indigo-500 dark:bg-transparent dark:text-indigo-400 dark:hover:text-indigo-300"
								>
									Update
								</button>
							</span>
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Email address</dt>
						<dd class="mt-1 flex text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							<span class="grow">margotfoster@example.com</span>
							<span class="ml-4 shrink-0">
								<button
									type="button"
									class="rounded-md bg-white font-medium text-indigo-600 hover:text-indigo-500 dark:bg-transparent dark:text-indigo-400 dark:hover:text-indigo-300"
								>
									Update
								</button>
							</span>
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Salary expectation</dt>
						<dd class="mt-1 flex text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							<span class="grow">$120,000</span>
							<span class="ml-4 shrink-0">
								<button
									type="button"
									class="rounded-md bg-white font-medium text-indigo-600 hover:text-indigo-500 dark:bg-transparent dark:text-indigo-400 dark:hover:text-indigo-300"
								>
									Update
								</button>
							</span>
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">About</dt>
						<dd class="mt-1 flex text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							<span class="grow">
								Fugiat ipsum ipsum deserunt culpa aute sint do nostrud anim incididunt cillum culpa
								consequat. Excepteur qui ipsum aliquip consequat sint. Sit id mollit nulla mollit
								nostrud in ea officia proident. Irure nostrud pariatur mollit ad adipisicing
								reprehenderit deserunt qui eu.
							</span>
							<span class="ml-4 shrink-0">
								<button
									type="button"
									class="rounded-md bg-white font-medium text-indigo-600 hover:text-indigo-500 dark:bg-transparent dark:text-indigo-400 dark:hover:text-indigo-300"
								>
									Update
								</button>
							</span>
						</dd>
					</div>
					<div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
						<dt class="text-sm/6 font-medium text-gray-900 dark:text-white">Attachments</dt>
						<dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0 dark:text-gray-400">
							<ul
								role="list"
								class="divide-y divide-gray-100 rounded-md border border-gray-200 dark:divide-white/5 dark:border-white/10"
							>
								<li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
									<div class="flex w-0 flex-1 items-center">
										<Paperclip
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										/>
										<div class="ml-4 flex min-w-0 flex-1 gap-2">
											<span class="truncate font-medium text-gray-900 dark:text-white">
												resume_back_end_developer.pdf
											</span>
											<span class="shrink-0 text-gray-400 dark:text-gray-500">2.4mb</span>
										</div>
									</div>
									<div class="ml-4 flex shrink-0 space-x-4">
										<button
											type="button"
											class="rounded-md bg-white font-medium text-indigo-600 hover:text-indigo-500 dark:bg-transparent dark:text-indigo-400 dark:hover:text-indigo-300"
										>
											Update
										</button>
										<span aria-hidden="true" class="text-gray-200 dark:text-gray-600">
											|
										</span>
										<button
											type="button"
											class="rounded-md bg-white font-medium text-gray-900 hover:text-gray-800 dark:bg-transparent dark:text-gray-400 dark:hover:text-white"
										>
											Remove
										</button>
									</div>
								</li>
								<li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
									<div class="flex w-0 flex-1 items-center">
										<Paperclip
											aria-hidden="true"
											class="size-5 shrink-0 text-gray-400 dark:text-gray-500"
										/>
										<div class="ml-4 flex min-w-0 flex-1 gap-2">
											<span class="truncate font-medium text-gray-900 dark:text-white">
												coverletter_back_end_developer.pdf
											</span>
											<span class="shrink-0 text-gray-400 dark:text-gray-500">4.5mb</span>
										</div>
									</div>
									<div class="ml-4 flex shrink-0 space-x-4">
										<button
											type="button"
											class="rounded-md bg-white font-medium text-indigo-600 hover:text-indigo-500 dark:bg-transparent dark:text-indigo-400 dark:hover:text-indigo-300"
										>
											Update
										</button>
										<span aria-hidden="true" class="text-gray-200 dark:text-gray-600">
											|
										</span>
										<button
											type="button"
											class="rounded-md bg-white font-medium text-gray-900 hover:text-gray-800 dark:bg-transparent dark:text-gray-400 dark:hover:text-white"
										>
											Remove
										</button>
									</div>
								</li>
							</ul>
						</dd>
					</div>
				</dl>
			</div>
		</div>
	);
}

export function DescriptionListsDemo() {
	return (
		<div class="space-y-12">
			<section>
				<h3 class="text-base font-semibold text-gray-900 dark:text-white mb-4">Left Aligned</h3>
				<LeftAligned />
			</section>
			<section>
				<h3 class="text-base font-semibold text-gray-900 dark:text-white mb-4">Two Column</h3>
				<TwoColumn />
			</section>
			<section>
				<h3 class="text-base font-semibold text-gray-900 dark:text-white mb-4">
					Left Aligned in Card
				</h3>
				<LeftAlignedInCard />
			</section>
			<section>
				<h3 class="text-base font-semibold text-gray-900 dark:text-white mb-4">
					Left Aligned Striped
				</h3>
				<LeftAlignedStriped />
			</section>
			<section>
				<h3 class="text-base font-semibold text-gray-900 dark:text-white mb-4">
					Narrow with Hidden Labels
				</h3>
				<NarrowWithHiddenLabels />
			</section>
		</div>
	);
}
