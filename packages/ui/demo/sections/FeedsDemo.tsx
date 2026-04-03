import { Check, ThumbsUp, User, CheckCircle, Circle } from 'lucide-preact';
import { classNames } from '../../src/internal/class-names.ts';

// ============================================================
// 01 - Simple with Icons
// ============================================================
const timeline = [
	{
		id: 1,
		content: 'Applied to',
		target: 'Front End Developer',
		href: '#',
		date: 'Sep 20',
		datetime: '2020-09-20',
		icon: User,
		iconBackground: 'bg-surface-3 dark:bg-surface-2',
	},
	{
		id: 2,
		content: 'Advanced to phone screening by',
		target: 'Bethany Blake',
		href: '#',
		date: 'Sep 22',
		datetime: '2020-09-22',
		icon: ThumbsUp,
		iconBackground: 'bg-blue-500',
	},
	{
		id: 3,
		content: 'Completed phone screening with',
		target: 'Martha Gardner',
		href: '#',
		date: 'Sep 28',
		datetime: '2020-09-28',
		icon: Check,
		iconBackground: 'bg-green-500',
	},
	{
		id: 4,
		content: 'Advanced to interview by',
		target: 'Bethany Blake',
		href: '#',
		date: 'Sep 30',
		datetime: '2020-09-30',
		icon: ThumbsUp,
		iconBackground: 'bg-blue-500',
	},
	{
		id: 5,
		content: 'Completed interview with',
		target: 'Katherine Snyder',
		href: '#',
		date: 'Oct 4',
		datetime: '2020-10-04',
		icon: Check,
		iconBackground: 'bg-green-500',
	},
];

export function SimpleWithIcons() {
	return (
		<div class="flow-root">
			<ul role="list" class="-mb-8">
				{timeline.map((event, eventIdx) => (
					<li key={event.id}>
						<div class="relative pb-8">
							{eventIdx !== timeline.length - 1 ? (
								<span
									aria-hidden="true"
									class="absolute top-4 left-4 -ml-px h-full w-0.5 bg-surface-2 dark:bg-white/10"
								/>
							) : null}
							<div class="relative flex space-x-3">
								<div>
									<span
										class={classNames(
											event.iconBackground,
											'flex size-8 items-center justify-center rounded-full ring-8 ring-surface-0 dark:ring-surface-1'
										)}
									>
										<event.icon aria-hidden="true" class="size-5 text-white" />
									</span>
								</div>
								<div class="flex min-w-0 flex-1 justify-between space-x-4 pt-1.5">
									<div>
										<p class="text-sm text-text-secondary">
											{event.content}{' '}
											<a href={event.href} class="font-medium text-text-primary">
												{event.target}
											</a>
										</p>
									</div>
									<div class="whitespace-nowrap text-right text-sm text-text-secondary">
										<time dateTime={event.datetime}>{event.date}</time>
									</div>
								</div>
							</div>
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}

// ============================================================
// 02 - With Comments
// ============================================================
const activity = [
	{
		id: 1,
		type: 'created',
		person: { name: 'Chelsea Hagon' },
		date: '7d ago',
		dateTime: '2023-01-23T10:32',
	},
	{
		id: 2,
		type: 'edited',
		person: { name: 'Chelsea Hagon' },
		date: '6d ago',
		dateTime: '2023-01-23T11:03',
	},
	{
		id: 3,
		type: 'sent',
		person: { name: 'Chelsea Hagon' },
		date: '6d ago',
		dateTime: '2023-01-23T11:24',
	},
	{
		id: 4,
		type: 'commented',
		person: {
			name: 'Chelsea Hagon',
			imageUrl:
				'https://images.unsplash.com/photo-1550525811-e5869dd03032?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
		},
		comment: 'Called client, they reassured me the invoice would be paid by the 25th.',
		date: '3d ago',
		dateTime: '2023-01-23T15:56',
	},
	{
		id: 5,
		type: 'viewed',
		person: { name: 'Alex Curren' },
		date: '2d ago',
		dateTime: '2023-01-24T09:12',
	},
	{
		id: 6,
		type: 'paid',
		person: { name: 'Alex Curren' },
		date: '1d ago',
		dateTime: '2023-01-24T09:20',
	},
];

export function WithComments() {
	return (
		<ul role="list" class="space-y-6">
			{activity.map((activityItem, activityItemIdx) => (
				<li key={activityItem.id} class="relative flex gap-x-4">
					<div
						class={classNames(
							activityItemIdx === activity.length - 1 ? 'h-6' : '-bottom-6',
							'absolute top-0 left-0 flex w-6 justify-center'
						)}
					>
						<div class="w-px bg-surface-2 dark:bg-white/15" />
					</div>
					{activityItem.type === 'commented' ? (
						<>
							<img
								alt=""
								src={activityItem.person.imageUrl}
								class="relative mt-3 size-6 flex-none rounded-full bg-surface-1 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
							/>
							<div class="flex-auto rounded-md p-3 ring-1 ring-surface-2 ring-inset dark:ring-white/15">
								<div class="flex justify-between gap-x-4">
									<div class="py-0.5 text-xs/5 text-text-secondary">
										<span class="font-medium text-text-primary">{activityItem.person.name}</span>{' '}
										commented
									</div>
									<time
										dateTime={activityItem.dateTime}
										class="flex-none py-0.5 text-xs/5 text-text-secondary"
									>
										{activityItem.date}
									</time>
								</div>
								<p class="text-sm/6 text-text-secondary">{activityItem.comment}</p>
							</div>
						</>
					) : (
						<>
							<div class="relative flex size-6 flex-none items-center justify-center bg-surface-0 dark:bg-surface-1">
								{activityItem.type === 'paid' ? (
									<CheckCircle
										aria-hidden="true"
										class="size-6 text-accent-500 dark:text-accent-400"
									/>
								) : (
									<Circle
										aria-hidden="true"
										class="size-1.5 rounded-full bg-surface-3 ring ring-surface-3 dark:bg-white/10 dark:ring-white/20"
									/>
								)}
							</div>
							<p class="flex-auto py-0.5 text-xs/5 text-text-secondary">
								<span class="font-medium text-text-primary">{activityItem.person.name}</span>{' '}
								{activityItem.type} the invoice.
							</p>
							<time
								dateTime={activityItem.dateTime}
								class="flex-none py-0.5 text-xs/5 text-text-secondary"
							>
								{activityItem.date}
							</time>
						</>
					)}
				</li>
			))}
		</ul>
	);
}

// ============================================================
// FeedsDemo - Main wrapper
// ============================================================
export function FeedsDemo() {
	return (
		<div class="space-y-8">
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">Simple with icons</h3>
				<SimpleWithIcons />
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-3">With comments</h3>
				<WithComments />
			</div>
		</div>
	);
}
