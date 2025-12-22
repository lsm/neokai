import { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Portal } from './Portal.tsx';
import { cn } from '../../lib/utils.ts';
import { borderColors } from '../../lib/design-tokens.ts';

export interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
	children: ComponentChildren;
	title?: string;
	size?: 'sm' | 'md' | 'lg' | 'xl';
	showCloseButton?: boolean;
}

export function Modal({
	isOpen,
	onClose,
	children,
	title,
	size = 'md',
	showCloseButton = true,
}: ModalProps) {
	const modalRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && isOpen) {
				onClose();
			}
		};

		if (isOpen) {
			document.addEventListener('keydown', handleEscape);
			document.body.style.overflow = 'hidden';
		}

		return () => {
			document.removeEventListener('keydown', handleEscape);
			document.body.style.overflow = '';
		};
	}, [isOpen, onClose]);

	useEffect(() => {
		if (isOpen && modalRef.current) {
			// Focus trap
			const focusableElements = modalRef.current.querySelectorAll(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			);
			const firstElement = focusableElements[0] as HTMLElement;
			const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

			const handleTab = (e: KeyboardEvent) => {
				if (e.key === 'Tab') {
					if (e.shiftKey) {
						if (document.activeElement === firstElement) {
							e.preventDefault();
							lastElement?.focus();
						}
					} else {
						if (document.activeElement === lastElement) {
							e.preventDefault();
							firstElement?.focus();
						}
					}
				}
			};

			modalRef.current.addEventListener('keydown', handleTab as EventListener);
			firstElement?.focus();

			return () => {
				modalRef.current?.removeEventListener('keydown', handleTab as EventListener);
			};
		}
	}, [isOpen]);

	if (!isOpen) return null;

	const sizes = {
		sm: 'max-w-md',
		md: 'max-w-lg',
		lg: 'max-w-2xl',
		xl: 'max-w-4xl',
	};

	const modalContent = (
		<div class="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fadeIn">
			{/* Backdrop */}
			<div class="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

			{/* Modal */}
			<div
				ref={modalRef}
				class={cn(
					`relative w-full bg-dark-900 rounded-xl shadow-2xl border ${borderColors.ui.default} animate-scaleIn flex flex-col max-h-[90vh]`,
					sizes[size]
				)}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				{(title || showCloseButton) && (
					<div
						class={`flex items-center justify-between px-6 py-4 border-b ${borderColors.ui.default} flex-shrink-0`}
					>
						{title && <h2 class="text-lg font-semibold text-gray-100">{title}</h2>}
						{showCloseButton && (
							<button
								type="button"
								onClick={onClose}
								class="ml-auto text-gray-400 hover:text-gray-100 transition-colors p-1 rounded-lg hover:bg-dark-800"
								aria-label="Close modal"
							>
								<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
							</button>
						)}
					</div>
				)}

				{/* Content */}
				<div class="px-6 py-4 overflow-y-auto flex-1">{children}</div>
			</div>
		</div>
	);

	// Render in portal to avoid z-index issues
	return <Portal into="body">{modalContent}</Portal>;
}
