export const en: Record<string, string> = {
	// Navigation
	'nav.rooms': 'Rooms',
	'nav.chats': 'Chats',
	'nav.settings': 'Settings',

	// Common
	'common.cancel': 'Cancel',
	'common.save': 'Save',
	'common.delete': 'Delete',
	'common.edit': 'Edit',
	'common.create': 'Create',
	'common.close': 'Close',
	'common.confirm': 'Confirm',
	'common.retry': 'Retry',
	'common.loading': 'Loading...',
	'common.processing': 'Processing...',
	'common.loadMore': 'Load More',
	'common.archived': 'Archived',
	'common.sessions': 'Sessions',
	'common.showAll': 'Show all ({count})',
	'common.rooms': 'Rooms',
	'common.tasks': 'Tasks',

	// Rooms page
	'rooms.title': 'Rooms',
	'rooms.countOne': '{count} room',
	'rooms.countOther': '{count} rooms',
	'rooms.createRoom': 'Create Room',
	'rooms.empty.title': 'No rooms yet',
	'rooms.empty.desc':
		'Rooms help organize your AI work. Create a room to set up goals, assign tasks, and manage sessions.',
	'rooms.empty.steps': '1. Create a room  2. Set context & goals  3. Let AI agents work',
	'rooms.empty.cta': 'Create Your First Room',

	// Sessions page
	'sessions.title': 'Sessions',
	'sessions.countOne': '{count} session',
	'sessions.countOther': '{count} sessions',
	'sessions.newSession': 'New Session',
	'sessions.empty.title': 'No sessions yet',
	'sessions.empty.desc': 'Sessions created outside of Rooms appear here',
	'sessions.welcome.title': 'Start a conversation',
	'sessions.welcome.desc': 'Create a new session to begin, or select one from the sidebar.',
	'sessions.showArchived': 'Show archived',
	'sessions.hideArchived': 'Hide archived',

	// Room detail
	'room.overview': 'Overview',
	'room.settings': 'Settings',
	'room.notFound': 'Room not found',
	'room.failedToLoad': 'Failed to load room',

	// Room Overview - Runtime
	'room.runtime.running': 'Running',
	'room.runtime.paused': 'Paused',
	'room.runtime.stopped': 'Stopped',
	'room.runtime.pause': 'Pause',
	'room.runtime.resume': 'Resume',
	'room.runtime.stop': 'Stop',
	'room.runtime.start': 'Start',
	'room.runtime.pauseTitle': 'Pause Room',
	'room.runtime.pauseMessage':
		'Pausing will prevent new tasks from starting. Running sessions will continue until finished.',
	'room.runtime.stopTitle': 'Stop Room',
	'room.runtime.stopMessage':
		'All active sessions will be terminated. You can restart the room later.',

	// Goals
	'goals.title': 'Goals',
	'goals.addGoal': 'Add Goal',
	'goals.createGoal': 'Create Goal',
	'goals.editGoal': 'Edit Goal',
	'goals.createFirst': 'Create First Goal',
	'goals.empty.title': 'Define your goals',
	'goals.empty.desc':
		'Goals describe what you want to achieve. AI agents will create tasks to work toward them.',
	'goals.form.title': 'Title',
	'goals.form.titlePlaceholder': 'What do you want to achieve?',
	'goals.form.description': 'Description',
	'goals.form.descriptionPlaceholder': 'Describe the goal in detail...',
	'goals.form.priority': 'Priority',
	'goals.priority.low': 'Low',
	'goals.priority.normal': 'Normal',
	'goals.priority.high': 'High',
	'goals.priority.urgent': 'Urgent',
	'goals.status.active': 'Active',
	'goals.status.needsInput': 'Needs Input',
	'goals.status.completed': 'Completed',
	'goals.status.archived': 'Archived',
	'goals.complete': 'Complete',
	'goals.reactivate': 'Reactivate',
	'goals.addDescription': 'Add description...',
	'goals.clickToEdit': 'Click to edit',
	'goals.clickToChangePriority': 'Click to change priority',
	'goals.inlineCreateHint': 'Enter to create, Esc to cancel',

	// Tasks
	'tasks.title': 'Tasks',
	'tasks.empty.title': 'No tasks yet',
	'tasks.empty.desc': 'Tasks break down room goals into actionable work items for AI agents.',
	'tasks.approve': 'Approve',
	'tasks.approveTitle': 'Approve Task',
	'tasks.approveMessage': 'This task will proceed to the next phase.',
	'tasks.blocked': 'Blocked',
	'tasks.failed': 'Failed',
	'tasks.retry': 'Retry',
	'tasks.activity': 'Activity',
	'tasks.status.inProgress': 'In Progress',
	'tasks.status.review': 'Review',
	'tasks.status.pending': 'Pending',
	'tasks.status.draft': 'Draft',
	'tasks.status.completed': 'Completed',
	'tasks.status.failed': 'Failed',
	'tasks.status.cancelled': 'Cancelled',
	'tasks.taskSummary.active': '{count} active',
	'tasks.taskSummary.done': '{count} done',
	'tasks.taskSummary.total': '{count} total',

	// Create Room Modal
	'createRoom.title': 'Create Room',
	'createRoom.nameLabel': 'Room Name',
	'createRoom.namePlaceholder': 'e.g., Website Development, Bug Fixes',
	'createRoom.nameRequired': 'Room name is required',
	'createRoom.backgroundLabel': 'Background',
	'createRoom.backgroundHelp':
		'Describe the project, its goals, and any important context for the AI agent.',
	'createRoom.backgroundPlaceholder': 'This room is focused on...',

	// Room Settings
	'roomSettings.context': 'Context',
	'roomSettings.agents': 'Agents',
	'roomSettings.roomSettings': 'Room Settings',
	'roomSettings.roomName': 'Room Name',
	'roomSettings.dangerZone': 'Danger Zone',
	'roomSettings.archive': 'Archive',
	'roomSettings.archiveDesc':
		'Hide from the active list. All data is preserved and can be restored later.',
	'roomSettings.archiveTitle': 'Archive Room',
	'roomSettings.archiveConfirm':
		'Are you sure you want to archive this room? It will be hidden from the active list but all data will be preserved.',
	'roomSettings.deleteRoom': 'Delete this room',
	'roomSettings.deleteDesc':
		'Permanently remove this room and all sessions, tasks, goals, and messages. Cannot be undone.',
	'roomSettings.deleteTitle': 'Delete Room Permanently',
	'roomSettings.deleteConfirm':
		'Are you sure you want to PERMANENTLY DELETE this room? All sessions, tasks, goals, and messages will be lost. This action cannot be undone.',
	'roomSettings.deletePermanently': 'Delete Permanently',
	'roomSettings.saveChanges': 'Save Changes',
	'roomSettings.saving': 'Saving...',
	'roomSettings.saved': 'Settings saved',
	'roomSettings.saveFailed': 'Failed to save settings',
	'roomSettings.maxReviewRounds': 'Max Review Rounds',
	'roomSettings.maxReviewRoundsDesc':
		'Maximum number of review iterations before failing the task.',
	'roomSettings.maxConcurrentTasks': 'Max Concurrent Tasks',
	'roomSettings.maxConcurrentTasksDesc':
		'Maximum number of tasks running in parallel. Takes effect on the next tick.',
	'roomSettings.maxPlanningRetries': 'Max Planning Retries',
	'roomSettings.maxPlanningRetriesDesc':
		'How many times the room will retry planning a goal after failure before escalating to human review. 0 means no automatic retries.',
	'roomSettings.allowedModels': 'Allowed Models',
	'roomSettings.allowedModelsDesc':
		'Enable the models available in this room. The default model is restricted to this list.',
	'roomSettings.selectAll': 'All',
	'roomSettings.selectNone': 'None',
	'roomSettings.loadingModels': 'Loading models...',
	'roomSettings.noModels': 'No models available',
	'roomSettings.defaultModel': 'Default Model',
	'roomSettings.defaultModelDesc':
		'Default model for new sessions in this room. Leave empty to use the system default.',
	'roomSettings.useSystemDefault': 'Use system default',
	'roomSettings.default': 'default',
	'roomSettings.workspacePaths': 'Workspace Paths',
	'roomSettings.workspacePathsDesc':
		'Allowed workspace paths for this room. The room agent can work on files in these directories.',
	'roomSettings.noWorkspacePaths': 'No workspace paths configured',
	'roomSettings.setDefault': 'Set Default',
	'roomSettings.addDescriptionPlaceholder': 'Add description (optional)',
	'roomSettings.pathPlaceholder': '/path/to/workspace',
	'roomSettings.descriptionPlaceholder': 'Description for this path (optional)',
	'roomSettings.addPath': 'Add Path',
	'roomSettings.folderPickerFailed': 'Failed to open folder picker',
	'roomSettings.archiveRoom': 'Archive Room',
	'roomSettings.archiveRoomLabel': 'Archive room',
	'roomSettings.sectionBasic': 'Basic Info',
	'roomSettings.sectionAI': 'AI Configuration',
	'roomSettings.sectionContext': 'Context',
	'roomSettings.sectionExecution': 'Execution',

	// Room toast messages
	'room.archivedSuccess': 'Room archived successfully',
	'room.deletedSuccess': 'Room deleted permanently',

	// Daemon status
	'daemon.connected': 'Daemon: Connected',
	'daemon.connecting': 'Daemon: Connecting...',
	'daemon.reconnecting': 'Daemon: Reconnecting...',
	'daemon.offline': 'Daemon: Offline',
	'daemon.error': 'Daemon: Error',

	// Connection overlay
	'connection.reconnectingLabel': 'Reconnecting...',

	// Tasks extra
	'tasks.view': 'View',
	'tasks.deps': 'Deps:',

	// Create room
	'createRoom.createRoom': 'Create Room',
	'createRoom.failed': 'Failed to create room',

	// Room Sessions
	'roomSessions.empty': 'No sessions in this room',
	'roomSessions.emptyDesc':
		'Sessions are created automatically when tasks are assigned to AI agents.',

	// Global Settings
	'settings.title': 'Global Settings',
	'settings.subtitle': 'Default configurations for new sessions',
	'settings.general': 'General',
	'settings.providers': 'Providers',
	'settings.mcpServers': 'MCP Servers',
	'settings.usage': 'Usage',
	'settings.about': 'About',
	'settings.language': 'Language',
	'settings.languageDesc': 'Interface language',
	'settings.defaultModel': 'Default Model',
	'settings.defaultModelDesc': 'Model for new sessions',
	'settings.permissionMode': 'Permission Mode',
	'settings.permissionModeDesc': 'How Claude asks for permissions',
	'settings.thinkingLevel': 'Default Thinking Level',
	'settings.thinkingLevelDesc': 'Thinking budget for new sessions',
	'settings.autoScroll': 'Auto-scroll',
	'settings.autoScrollDesc': 'Auto-scroll to new messages',
	'settings.showArchived': 'Show Archived Sessions',
	'settings.showArchivedDesc': 'Display archived sessions in lists',

	// Connection
	'connection.connected': 'Connected',
	'connection.connecting': 'Connecting...',
	'connection.reconnecting': 'Reconnecting...',
	'connection.failed': 'Connection Failed',
	'connection.offline': 'Offline',
	'connection.failedTitle': 'Connection Failed',
	'connection.failedDesc': 'Unable to establish connection after multiple attempts.',
	'connection.reconnect': 'Reconnect',
	'connection.refreshPage': 'Refresh Page',
	'connection.persistHint':
		'If the problem persists, check your network connection or try restarting the server.',

	// Chat
	'chat.newSession': 'New Session',
	'chat.tools': 'Tools',
	'chat.sessionInfo': 'Session Info',
	'chat.exportChat': 'Export Chat',
	'chat.resetAgent': 'Reset Agent',
	'chat.archiveSession': 'Archive Session',
	'chat.deleteChat': 'Delete Chat',
	'chat.notConnected': 'Not connected to server. Please wait...',
	'chat.sessionCreated': 'Session created successfully',
	'chat.connectionLost': 'Connection lost. Please try again.',
	'chat.createFailed': 'Failed to create session',

	// Error
	'error.details': 'Error Details',
	'error.whatToTry': 'What you can try:',
	'error.technicalDetails': 'Technical Details',
	'error.copyReport': 'Copy Error Report',
	'error.copied': 'Copied!',

	// Common UI
	'common.goHome': 'Go Home',
	'common.enter': 'Enter',
	'common.unknown': 'Unknown',
	'common.sessionOne': '{count} session',
	'common.sessionOther': '{count} sessions',
	'common.reviewOne': '{count} review',
	'common.reviewOther': '{count} reviews',
	'common.updated': 'Updated {time}',
	'common.timeJustNow': 'just now',
	'common.timeMinutes': '{count}m ago',
	'common.timeHours': '{count}h ago',
	'common.timeDays': '{count}d ago',

	// Chat dialogs
	'chat.deleteTitle': 'Delete Chat',
	'chat.deleteConfirm':
		'Are you sure you want to delete this chat session? This action cannot be undone.',
	'chat.rewindTitle': 'Rewind Conversation',
	'chat.rewindBeforeMessage':
		'This will rewind the conversation to before this message. Choose what to restore:',
	'chat.rewindToPoint':
		'This will rewind the conversation to the selected point. Choose what to restore:',
	'chat.rewindFilesAndConversation': 'Files & Conversation',
	'chat.rewindFilesOnly': 'Files only',
	'chat.rewindConversationOnly': 'Conversation only',
	'chat.rewindCannotUndo': 'This action cannot be undone.',
	'chat.rewinding': 'Rewinding...',
	'chat.rewind': 'Rewind',

	// Archive confirm
	'archive.confirmTitle': 'Confirm Archive',
	'archive.uncommittedChanges': 'This worktree has {count} uncommitted changes:',
	'archive.commitsLostWarning':
		'These commits will be lost when the worktree is removed. Continue?',
	'archive.archiving': 'Archiving...',
	'archive.archiveAnyway': 'Archive Anyway',

	// Lobby
	'lobby.title': 'Neo Lobby',
	'lobby.subtitle': 'Your agent command center',
	'lobby.recentSessions': 'Recent Sessions',
	'lobby.failedToLoad': 'Failed to load lobby',

	// Chat header
	'chat.resetting': 'Resetting...',
	'chat.session': 'Session',
	'chat.newSessionTitle': 'New Session',
	'chat.totalTokens': 'Total tokens',
	'chat.sessionOptions': 'Session options',
	'chat.worktreeTooltip': 'Using isolated git worktree',

	// Input actions
	'input.notConnected': 'Not connected',
	'input.moreOptions': 'More options',
	'input.autoScroll': 'Auto-scroll',
	'input.rewindMode': 'Rewind Mode',
	'input.exitRewindMode': 'Exit Rewind Mode',
	'input.attachImage': 'Attach image',
	'input.dropImagesHere': 'Drop images here',
	'input.supportedFormats': 'PNG, JPG, GIF, or WebP',
	'input.removeAttachment': 'Remove attachment',
	'input.stopGeneration': 'Stop generation (Esc)',
	'input.stopGenerationLabel': 'Stop generation',
	'input.sendMessage': 'Send message',
	'input.chatWithCoordinator': 'Chat with the room coordinator...',
	'input.askOrMake': 'Ask or make anything...',
	'input.queueNow': 'Now',
	'input.queueNext': 'Next',
	'input.morePending': '+{count} more pending',
	'input.moreQueued': '+{count} more queued',

	// Session status bar
	'status.coordinatorMode': 'Coordinator Mode',
	'status.coordinatorEnabled': 'Coordinator Mode (enabled)',
	'status.coordinatorDisabled': 'Coordinator Mode (disabled)',
	'status.sandboxMode': 'Sandbox Mode',
	'status.sandboxEnabled': 'Sandbox Mode (enabled)',
	'status.sandboxDisabled': 'Sandbox Mode (disabled)',
	'status.switchModel': 'Switch Model',
	'status.modelName': 'Model: {name}',
	'status.switchModelName': 'Switch Model ({name})',
	'status.selectModel': 'Select Model',
	'status.current': '(current)',
	'status.thinkingLevel': 'Thinking Level',
	'status.thinking': 'Thinking: {level}',
	'status.autoScrollEnabled': 'Auto-scroll (enabled)',
	'status.autoScrollDisabled': 'Auto-scroll (disabled)',
	'status.scrollToBottom': 'Scroll to bottom',

	// Context usage
	'context.clickForDetails': 'Click for context details',
	'context.dataLoading': 'Context data loading...',
	'context.usage': 'Context Usage',
	'context.contextWindow': 'Context Window',
	'context.breakdown': 'Breakdown',
	'context.model': 'Model:',

	// Error banner
	'error.viewDetails': 'View Details',
	'error.dismiss': 'Dismiss error',

	// Task view
	'task.loadingTask': 'Loading task…',
	'task.notFound': 'Task not found',
	'task.backToRoom': '← Back to room',
	'task.failedToApprove': 'Failed to approve task',
	'task.failedToSendFeedback': 'Failed to send feedback',
	'task.failedToSendMessage': 'Failed to send message',
	'task.awaitingReview': 'Awaiting your review',
	'task.reviewHint': 'Review the PR and approve or provide feedback',
	'task.approving': 'Approving…',
	'task.approve': '✓ Approve',
	'task.sendFeedback': 'Send Feedback',
	'task.sending': 'Sending…',
	'task.feedbackPlaceholder': 'Send feedback to request changes… (⌘↵ to send)',
	'task.leaderPlaceholder': 'Send a message to the leader… (⌘↵ to send)',
	'task.workerRunning': 'Worker is running — wait for leader review',
	'task.noActiveGroup': 'No active agent group',
	'task.waitingForRuntime': 'Waiting for the runtime to pick up this task.',
	'task.taskCompleted': 'This task has been completed.',
	'task.taskFailed': 'This task has failed.',
	'task.retrying': 'Retrying...',
	'task.taskReview': 'This task is awaiting human review.',
	'task.taskDraft': 'This task is a draft and has not been scheduled yet.',
	'task.taskCancelled': 'This task was cancelled.',
	'task.noGroupSpawned': 'No agent group has been spawned yet.',
	'task.taskInfo': 'Task info',
	'task.taskId': 'Task ID:',
	'task.groupId': 'Group ID:',
	'task.worker': 'Worker:',
	'task.leader': 'Leader:',
	'task.workerWorktree': 'Worker worktree:',
	'task.leaderWorktree': 'Leader worktree:',
	'task.modelLabel': 'model: {model}',
	'task.dependsOn': 'Depends on:',
	'task.iteration': 'iteration {count}',
	'task.disableAutoScroll': 'Disable auto-scroll',
	'task.enableAutoScroll': 'Enable auto-scroll',
	'task.taskPrefix': 'Task: {title}',
	'task.room': 'Room',
	'task.copiedToClipboard': 'Copied!',
	'task.copyToClipboard': 'Copy to clipboard',

	// Group state labels
	'task.state.awaitingWorker': 'Worker active…',
	'task.state.awaitingLeader': 'Leader reviewing…',
	'task.state.awaitingHuman': 'Needs human review',
	'task.state.completed': 'Completed',
	'task.state.failed': 'Failed',

	// Room context panel
	'roomPanel.allRooms': 'All Rooms',
	'roomPanel.newSession': 'New Session',
	'roomPanel.noTasks': 'No tasks',
	'roomPanel.pending': '{count} pending',
	'roomPanel.active': '{count} active',
	'roomPanel.done': '{count} done',
	'roomPanel.roomDashboard': 'Room Dashboard',
	'roomPanel.roomAgent': 'Room Agent',
	'roomPanel.noSessions': 'No sessions yet',

	// Toast messages
	'toast.rewindSuccess': 'Rewound successfully: {details}',
	'toast.rewindFailed': 'Rewind failed: {error}',
	'toast.loadOlderFailed': 'Failed to load older messages',
	'toast.connectionLost': 'Connection lost.',
	'toast.workspaceModeFailed': 'Failed to set workspace mode',
	'toast.autoScrollFailed': 'Failed to save auto-scroll setting',
	'toast.coordinatorFailed': 'Failed to toggle coordinator mode',
	'toast.sandboxFailed': 'Failed to toggle sandbox mode',
	'toast.archivedToggleFailed': 'Failed to toggle archived sessions visibility',
	'toast.noSessionId': 'No sessionId in response',
	'toast.sessionDeleted': 'Session deleted',
	'toast.sessionDeleteFailed': 'Failed to delete session',
	'toast.modelAlreadyUsing': 'Already using {name}',
	'toast.modelSwitched': 'Switched to {name}',
	'toast.modelSwitchFailed': 'Failed to switch model',
	'toast.contextSaved': 'Context saved',
	'toast.agentConfigSaved': 'Agent configuration saved',
	'toast.saveFailed': 'Failed to save',
	'toast.copied': 'Message copied to clipboard',
	'toast.copyFailed': 'Failed to copy message',
	'toast.toolOutputRemoved': 'Tool output removed. Reloading session...',
	'toast.cannotDelete': 'Cannot delete: missing message or session ID',
	'toast.settingUpdateFailed': 'Failed to update setting',
	'toast.providerAuthSuccess': '{name} authenticated successfully',
	'toast.providerAuthFailed': 'Failed to start OAuth flow',
	'toast.loginFailed': 'Failed to start login',
	'toast.logoutSuccess': 'Logged out from {name}',
	'toast.logoutFailed': 'Failed to logout',
	'toast.providerLoadFailed': 'Failed to load provider statuses',
	'toast.mcpLoadFailed': 'Failed to load MCP servers',
	'toast.mcpToggleFailed': 'Failed to {action} server',
	'toast.toolsConfigSaved': 'Tools configuration saved',
	'toast.toolsConfigFailed': 'Failed to save tools configuration',
	'toast.toolsMinSource': 'At least one setting source must be enabled',
	'toast.taskReviewReady': 'Task ready for review: {title}',
	'toast.daemonConnectFailed': 'Failed to connect to daemon',

	// Chat container
	'chat.failedToLoad': 'Failed to load session',
	'chat.rewindingTitle': 'Rewinding conversation...',
	'chat.rewindingDesc': 'This may take a moment',
	'chat.beginningOfConversation': 'Beginning of conversation',
	'chat.noMessages': 'No messages yet',
	'chat.noMessagesDesc': 'Start a conversation with Claude to see the magic happen',

	// Lobby extra
	'lobby.newSession': 'New Session',
	'lobby.createRoom': 'Create Room',

	// Room context
	'roomContext.instructions': 'Instructions',
	'roomContext.instructionsDesc':
		'Custom instructions for how room agents should behave. Coding standards, preferred tools, workflow guidelines, etc.',
	'roomContext.contextPlaceholder': 'Describe the project context, architecture, and goals...',
	'roomContext.instructionsPlaceholder': 'Add behavioral guidelines for room agents...',

	// Goals editor extra
	'goals.deleteTitle': 'Delete Goal',
	'goals.deleteConfirm': 'Are you sure you want to delete "{title}"? This action cannot be undone.',
	'goals.goalTitlePlaceholder': 'Enter goal title...',
	'goals.goalDescPlaceholder': 'Describe the goal...',
	'goals.linkTaskPlaceholder': 'Enter task ID to link...',
	'goals.selectModel': 'Select model',

	// Room dashboard extra
	'roomDashboard.agents': 'Agents',

	// MCP settings
	'mcp.loadingServers': 'Loading servers...',
	'mcp.enableAction': 'enable',
	'mcp.disableAction': 'disable',

	// Tools modal
	'tools.title': 'Tools',

	// Question prompt
	'question.responsePlaceholder': 'Enter your response...',

	// Session list item
	'session.archivedTitle': 'Archived session',

	// New session modal
	'newSession.title': 'New Session',
	'newSession.workspaceLabel': 'Where do you want to work?',
	'newSession.selectPath': 'Select a recent path...',
	'newSession.or': 'or',
	'newSession.pathPlaceholder': 'Enter workspace path...',
	'newSession.browse': 'Browse for folder...',
	'newSession.browseSoon': 'Browse functionality coming soon',
	'newSession.assignRoom': 'Assign to Room (optional)',
	'newSession.noRoom': 'No room',
	'newSession.createNewRoom': '+ Create new room...',
	'newSession.createRoomTitle': 'Create New Room',
	'newSession.roomName': 'Room Name',
	'newSession.roomNamePlaceholder': 'e.g., Website Development',
	'newSession.roomDescLabel': 'Description (optional)',
	'newSession.roomDescPlaceholder': 'What will this room be used for?',
	'newSession.createRoom': 'Create Room',
	'newSession.createSession': 'Create Session',
	'newSession.pathRequired': 'Workspace path is required',
	'newSession.roomNameRequired': 'Room name is required',
	'newSession.createRoomUnavailable': 'Create room not available',
	'newSession.createSessionFailed': 'Failed to create session',
	'newSession.createRoomFailed': 'Failed to create room',

	// Session actions extra
	'toast.sessionArchived': 'Session archived successfully',
	'toast.agentReset': 'Agent reset successfully.',
	'toast.chatExported': 'Chat exported!',
	'toast.exportFailed': 'Failed to export chat',
	'toast.notConnected': 'Not connected to server',
	'toast.stopFailed': 'Failed to stop generation',
	'toast.sendArchived': 'Cannot send messages to archived sessions',
	'toast.sendTimeout': 'Message send timed out.',
	'toast.sendConnectionLost': 'Connection lost.',
	'toast.sendRefresh': 'Connection lost. Please refresh the page.',

	// Room agent avatars
	'roomAgentAvatars.defaultModel': 'Default model',
	'roomAgentAvatars.manage': 'Manage agents',
	'roomAgentAvatars.add': 'Add agent',
	'roomAgentAvatars.working': 'Working',

	// Agent settings popover
	'roomAgentPopover.model': 'Model',
	'roomAgentPopover.subAgentClis': 'Sub Agent CLIs',
	'roomAgentPopover.subAgentModels': 'Sub Agent Models',
};
