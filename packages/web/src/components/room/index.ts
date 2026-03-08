/**
 * Room components package
 *
 * Components for room-based task management and goals configuration.
 */

// @public - Library export
export { GoalsEditor } from './GoalsEditor';
// @public - Library export
export { RoomContext } from './RoomContext';
export type { RoomContextProps } from './RoomContext';
// @public - Library export
export { RoomSettings } from './RoomSettings';
export type { RoomSettingsProps } from './RoomSettings';
// Sub-components re-exported for AgentSettingsPopover
export { ModelPicker, ModelTagsInput, CliTagsInput } from './RoomAgents';
// @public - Library export
export { RoomAgentAvatars } from './RoomAgentAvatars';
export type { RoomAgentAvatarsProps } from './RoomAgentAvatars';
// @public - Library export
export { AgentSettingsPopover } from './AgentSettingsPopover';
export type { AgentSettingsPopoverProps } from './AgentSettingsPopover';
