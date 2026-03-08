import { Fragment } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { ChevronRightIcon } from '../icons/index';

export interface BreadcrumbItem {
	label: string;
	onClick?: () => void;
	onEdit?: (newLabel: string) => void;
}

export interface BreadcrumbProps {
	items: BreadcrumbItem[];
}

function EditableLabel({
	label,
	onEdit,
}: {
	label: string;
	onEdit: (newLabel: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(label);
	const inputRef = useRef<HTMLInputElement>(null);

	const startEdit = () => {
		setDraft(label);
		setEditing(true);
		requestAnimationFrame(() => inputRef.current?.select());
	};

	const save = () => {
		setEditing(false);
		const trimmed = draft.trim();
		if (trimmed && trimmed !== label) {
			onEdit(trimmed);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			save();
		} else if (e.key === 'Escape') {
			setEditing(false);
		}
	};

	if (editing) {
		return (
			<input
				ref={inputRef}
				type="text"
				value={draft}
				onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
				onBlur={save}
				onKeyDown={handleKeyDown}
				class="text-lg text-gray-200 font-semibold bg-transparent border-b border-blue-500 outline-none max-w-[200px]"
			/>
		);
	}

	return (
		<span
			class="text-lg text-gray-200 font-semibold truncate max-w-[200px] cursor-text hover:text-white transition-colors"
			onClick={startEdit}
		>
			{label}
		</span>
	);
}

export function Breadcrumb({ items }: BreadcrumbProps) {
	return (
		<nav class="flex items-center gap-1">
			{items.map((item, index) => {
				const isLast = index === items.length - 1;
				return (
					<Fragment key={index}>
						{index > 0 && (
							<ChevronRightIcon className="w-4 h-4 text-gray-500 flex-shrink-0" />
						)}
						{isLast ? (
							item.onEdit ? (
								<EditableLabel label={item.label} onEdit={item.onEdit} />
							) : (
								<span class="text-lg text-gray-200 font-semibold truncate max-w-[200px]">
									{item.label}
								</span>
							)
						) : (
							<button
								class="text-lg text-gray-400 hover:text-gray-200 cursor-pointer transition-colors truncate max-w-[200px]"
								onClick={item.onClick}
							>
								{item.label}
							</button>
						)}
					</Fragment>
				);
			})}
		</nav>
	);
}
