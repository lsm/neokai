import { ChevronLeft, ChevronRight, Pencil, Trash } from 'lucide-preact';

export function ButtonGroupsDemo() {
	return (
		<div class="space-y-12">
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">Basic button group</h3>
				<span class="isolate inline-flex rounded-md shadow-xs dark:shadow-none">
					<button
						type="button"
						class="relative inline-flex items-center rounded-l-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 inset-ring-1 inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/10 dark:text-white dark:inset-ring-gray-700 dark:hover:bg-white/20"
					>
						Years
					</button>
					<button
						type="button"
						class="relative -ml-px inline-flex items-center bg-white px-3 py-2 text-sm font-semibold text-gray-900 inset-ring-1 inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/10 dark:inset-ring-gray-700 dark:hover:bg-white/20"
					>
						Months
					</button>
					<button
						type="button"
						class="relative -ml-px inline-flex items-center rounded-r-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 inset-ring-1 inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/10 dark:inset-ring-gray-700 dark:hover:bg-white/20"
					>
						Days
					</button>
				</span>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">
					Icon-only with chevron navigation
				</h3>
				<span class="isolate inline-flex rounded-md shadow-xs dark:shadow-none">
					<button
						type="button"
						class="relative inline-flex items-center rounded-l-md bg-white px-2 py-2 text-gray-400 inset-ring-1 inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/10 dark:inset-ring-gray-700 dark:hover:bg-white/20"
					>
						<span class="sr-only">Previous</span>
						<ChevronLeft class="size-5" />
					</button>
					<button
						type="button"
						class="relative -ml-px inline-flex items-center rounded-r-md bg-white px-2 py-2 text-gray-400 inset-ring-1 inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/10 dark:inset-ring-gray-700 dark:hover:bg-white/20"
					>
						<span class="sr-only">Next</span>
						<ChevronRight class="size-5" />
					</button>
				</span>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">
					Icon-only with edit/delete actions
				</h3>
				<span class="isolate inline-flex rounded-md shadow-xs dark:shadow-none">
					<button
						type="button"
						class="relative inline-flex items-center rounded-l-md bg-white px-3 py-2 text-gray-400 inset-ring-1 inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/10 dark:inset-ring-gray-700 dark:hover:bg-white/20"
					>
						<span class="sr-only">Edit</span>
						<Pencil class="size-5" />
					</button>
					<button
						type="button"
						class="relative -ml-px inline-flex items-center rounded-r-md bg-white px-3 py-2 text-gray-400 inset-ring-1 inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/10 dark:inset-ring-gray-700 dark:hover:bg-white/20"
					>
						<span class="sr-only">Delete</span>
						<Trash class="size-5" />
					</button>
				</span>
			</div>
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-4">Icon-only segmented control</h3>
				<span class="isolate inline-flex rounded-md shadow-xs dark:shadow-none">
					<button
						type="button"
						class="relative inline-flex items-center rounded-l-md bg-indigo-600 px-3 py-2 text-white shadow-xs hover:bg-indigo-500 focus:z-10 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400"
					>
						<Pencil class="size-5" />
					</button>
					<button
						type="button"
						class="relative -ml-px inline-flex items-center bg-white px-3 py-2 text-gray-400 inset-ring-1 inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/10 dark:inset-ring-gray-700 dark:hover:bg-white/20"
					>
						<Trash class="size-5" />
					</button>
					<button
						type="button"
						class="relative -ml-px inline-flex items-center rounded-r-md bg-white px-3 py-2 text-gray-400 inset-ring-1 inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/10 dark:inset-ring-gray-700 dark:hover:bg-white/20"
					>
						<ChevronRight class="size-5" />
					</button>
				</span>
			</div>
		</div>
	);
}
