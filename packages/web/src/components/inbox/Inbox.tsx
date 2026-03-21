import { useEffect } from 'preact/hooks';
import { inboxStore, type InboxTask } from '../../lib/inbox-store.ts';
import { Spinner } from '../ui/Spinner.tsx';
import {
	currentRoomIdSignal,
	currentRoomTaskIdSignal,
	navSectionSignal,
} from '../../lib/signals.ts';

function InboxTaskCard({ item }: { item: InboxTask }) {
	const handleReview = () => {
		navSectionSignal.value = 'rooms';
		currentRoomIdSignal.value = item.roomId;
		currentRoomTaskIdSignal.value = item.task.id;
	};

	return (
		<div class="flex items-start gap-3 px-4 py-3 border-b border-dark-700 hover:bg-dark-800 transition-colors border-l-[3px] border-l-amber-500">
			<div class="flex-1 min-w-0">
				<p class="text-gray-100 font-medium text-sm truncate">{item.task.title}</p>
				<p class="text-gray-500 text-xs mt-0.5">{item.roomTitle}</p>
			</div>
			<button
				type="button"
				onClick={handleReview}
				class="shrink-0 px-3 py-1 text-xs font-medium rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors"
			>
				Review
			</button>
		</div>
	);
}

function EmptyState() {
	return (
		<div class="flex flex-col items-center justify-center h-full gap-2 text-gray-500">
			<p class="text-sm">No tasks awaiting review</p>
		</div>
	);
}

export function Inbox() {
	const items = inboxStore.items.value;
	const isLoading = inboxStore.isLoading.value;
	const count = inboxStore.reviewCount.value;

	useEffect(() => {
		inboxStore.refresh();
	}, []);

	return (
		<div class="flex flex-col h-full">
			<div class="px-6 py-4 border-b border-dark-700 flex items-center justify-between">
				<h1 class="text-lg font-semibold text-gray-100">Inbox</h1>
				<span class="text-xs text-gray-500">{count} awaiting review</span>
			</div>
			<div class="flex-1 overflow-y-auto">
				{isLoading && (
					<div class="flex items-center justify-center p-8">
						<Spinner size="md" />
					</div>
				)}
				{!isLoading && items.length === 0 && <EmptyState />}
				{!isLoading &&
					items.map((item) => <InboxTaskCard key={item.task.id} item={item} />)}
			</div>
		</div>
	);
}
