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
} from './useMessageHub';
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
