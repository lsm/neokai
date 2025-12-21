/**
 * Hooks Index
 *
 * Re-exports all custom hooks for convenient importing.
 *
 * @example
 * ```typescript
 * import { useModal, useAutoScroll, useMessageHub } from '../hooks';
 * ```
 */

export { useModal, type UseModalResult } from './useModal';
export { useClickOutside } from './useClickOutside';
export {
	useAsyncOperation,
	type UseAsyncOperationOptions,
	type UseAsyncOperationResult,
} from './useAsyncOperation';
export {
	useAutoScroll,
	type UseAutoScrollOptions,
	type UseAutoScrollResult,
} from './useAutoScroll';
export { useMessageMaps, type UseMessageMapsResult, type ToolResultData } from './useMessageMaps';
export { useInputDraft, type UseInputDraftResult } from './useInputDraft';
export {
	useModelSwitcher,
	type UseModelSwitcherResult,
	MODEL_FAMILY_ICONS,
} from './useModelSwitcher';
export {
	useMessageHub,
	type UseMessageHubOptions,
	type UseMessageHubResult,
	ConnectionNotReadyError,
} from './useMessageHub';
export {
	useSessionSubscriptions,
	type SessionSubscriptionState,
	type SessionSubscriptionCallbacks,
	type UseSessionSubscriptionsOptions,
	type UseSessionSubscriptionsResult,
} from './useSessionSubscriptions';
export {
	useSessionActions,
	type ArchiveConfirmState,
	type UseSessionActionsOptions,
	type UseSessionActionsResult,
} from './useSessionActions';
export {
	useMessageLoader,
	type UseMessageLoaderOptions,
	type UseMessageLoaderResult,
} from './useMessageLoader';
export {
	useSendMessage,
	type UseSendMessageOptions,
	type UseSendMessageResult,
} from './useSendMessage';
export {
	useCommandAutocomplete,
	type UseCommandAutocompleteOptions,
	type UseCommandAutocompleteResult,
} from './useCommandAutocomplete';
export { useInterrupt, type UseInterruptOptions, type UseInterruptResult } from './useInterrupt';
export {
	useFileAttachments,
	type AttachmentWithMetadata,
	type UseFileAttachmentsResult,
} from './useFileAttachments';
