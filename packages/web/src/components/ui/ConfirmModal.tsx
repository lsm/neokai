/**
 * ConfirmModal Component
 *
 * A confirmation dialog built on top of the Modal component.
 * Used for destructive actions that require user confirmation.
 */

import { Modal } from "./Modal.tsx";

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmButtonVariant?: "danger" | "primary";
  isLoading?: boolean;
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmButtonVariant = "danger",
  isLoading = false,
}: ConfirmModalProps) {
  const handleConfirm = () => {
    onConfirm();
    // Note: onClose will be called by parent after confirmation succeeds
  };

  const confirmButtonClasses =
    confirmButtonVariant === "danger"
      ? "bg-red-600 hover:bg-red-700 text-white disabled:bg-red-600/50"
      : "bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-600/50";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      showCloseButton={false}
    >
      <div class="space-y-4">
        {/* Message */}
        <p class="text-gray-300 text-sm leading-relaxed">{message}</p>

        {/* Actions */}
        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isLoading}
            class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed ${confirmButtonClasses}`}
          >
            {isLoading ? "Processing..." : confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
}
