export const zh: Record<string, string> = {
	// Navigation
	'nav.rooms': '工作室',
	'nav.chats': '会话',
	'nav.settings': '设置',

	// Common
	'common.cancel': '取消',
	'common.save': '保存',
	'common.delete': '删除',
	'common.edit': '编辑',
	'common.create': '创建',
	'common.close': '关闭',
	'common.confirm': '确认',
	'common.retry': '重试',
	'common.loading': '加载中...',
	'common.processing': '处理中...',
	'common.loadMore': '加载更多',
	'common.archived': '已归档',
	'common.sessions': '会话',
	'common.showAll': '查看全部（{count}）',
	'common.rooms': '工作室',
	'common.tasks': '任务',

	// Rooms page
	'rooms.title': '工作室',
	'rooms.countOne': '{count} 个工作室',
	'rooms.countOther': '{count} 个工作室',
	'rooms.createRoom': '创建工作室',
	'rooms.empty.title': '暂无工作室',
	'rooms.empty.desc':
		'工作室帮助你组织 AI 工作。创建工作室来设定目标、分配任务和管理会话。',
	'rooms.empty.steps': '1. 创建工作室  2. 设定背景与目标  3. 让 AI 代理开始工作',
	'rooms.empty.cta': '创建第一个工作室',

	// Sessions page
	'sessions.title': '会话',
	'sessions.countOne': '{count} 个会话',
	'sessions.countOther': '{count} 个会话',
	'sessions.newSession': '新建会话',
	'sessions.empty.title': '暂无会话',
	'sessions.empty.desc': '在工作室之外创建的会话会显示在这里',
	'sessions.showArchived': '显示已归档',
	'sessions.hideArchived': '隐藏已归档',

	// Room detail
	'room.overview': '概览',
	'room.settings': '设置',
	'room.notFound': '未找到工作室',
	'room.failedToLoad': '加载工作室失败',

	// Room Overview - Runtime
	'room.runtime.running': '运行中',
	'room.runtime.paused': '已暂停',
	'room.runtime.stopped': '已停止',
	'room.runtime.pause': '暂停',
	'room.runtime.resume': '恢复',
	'room.runtime.stop': '停止',
	'room.runtime.start': '启动',
	'room.runtime.pauseTitle': '暂停工作室',
	'room.runtime.pauseMessage':
		'暂停后将不会启动新任务。正在运行的会话会继续直到完成。',
	'room.runtime.stopTitle': '停止工作室',
	'room.runtime.stopMessage':
		'所有活跃会话将被终止。你可以稍后重新启动工作室。',

	// Goals
	'goals.title': '目标',
	'goals.addGoal': '添加目标',
	'goals.createGoal': '创建目标',
	'goals.editGoal': '编辑目标',
	'goals.createFirst': '创建第一个目标',
	'goals.empty.title': '定义你的目标',
	'goals.empty.desc':
		'目标描述你想要达成的事项。AI 代理会创建任务来实现这些目标。',
	'goals.form.title': '标题',
	'goals.form.titlePlaceholder': '你想要达成什么？',
	'goals.form.description': '描述',
	'goals.form.descriptionPlaceholder': '详细描述目标...',
	'goals.form.priority': '优先级',
	'goals.priority.low': '低',
	'goals.priority.normal': '普通',
	'goals.priority.high': '高',
	'goals.priority.urgent': '紧急',
	'goals.status.active': '进行中',
	'goals.status.needsInput': '需要输入',
	'goals.status.completed': '已完成',
	'goals.status.archived': '已归档',
	'goals.complete': '完成',
	'goals.reactivate': '重新激活',
	'goals.addDescription': '添加描述...',
	'goals.clickToEdit': '点击编辑',
	'goals.clickToChangePriority': '点击切换优先级',
	'goals.inlineCreateHint': '回车创建，Esc 取消',

	// Tasks
	'tasks.title': '任务',
	'tasks.empty.title': '暂无任务',
	'tasks.empty.desc':
		'任务将工作室目标拆分为可执行的工作项，由 AI 代理完成。',
	'tasks.approve': '批准',
	'tasks.approveTitle': '批准任务',
	'tasks.approveMessage': '此任务将进入下一阶段。',
	'tasks.blocked': '已阻塞',
	'tasks.failed': '已失败',
	'tasks.activity': '活动',
	'tasks.status.inProgress': '进行中',
	'tasks.status.review': '审核中',
	'tasks.status.pending': '待处理',
	'tasks.status.draft': '草稿',
	'tasks.status.completed': '已完成',
	'tasks.status.failed': '已失败',
	'tasks.status.cancelled': '已取消',
	'tasks.taskSummary.active': '{count} 个进行中',
	'tasks.taskSummary.done': '{count} 个已完成',
	'tasks.taskSummary.total': '共 {count} 个',

	// Create Room Modal
	'createRoom.title': '创建工作室',
	'createRoom.nameLabel': '工作室名称',
	'createRoom.namePlaceholder': '例如：网站开发、问题修复',
	'createRoom.nameRequired': '工作室名称不能为空',
	'createRoom.backgroundLabel': '背景（可选）',
	'createRoom.backgroundHelp':
		'描述项目、目标以及 AI 代理需要了解的重要背景信息。',
	'createRoom.backgroundPlaceholder': '这个工作室专注于...',

	// Room Settings
	'roomSettings.context': '上下文',
	'roomSettings.agents': '代理',
	'roomSettings.roomSettings': '工作室设置',
	'roomSettings.roomName': '工作室名称',
	'roomSettings.dangerZone': '危险操作',
	'roomSettings.archive': '归档',
	'roomSettings.archiveDesc':
		'从活跃列表中隐藏。所有数据将被保留，可以稍后恢复。',
	'roomSettings.archiveTitle': '归档工作室',
	'roomSettings.archiveConfirm':
		'确定要归档此工作室吗？它将从活跃列表中隐藏，但所有数据都会保留。',
	'roomSettings.deleteRoom': '删除此工作室',
	'roomSettings.deleteDesc':
		'永久删除此工作室及其所有会话、任务、目标和消息。此操作不可撤销。',
	'roomSettings.deleteTitle': '永久删除工作室',
	'roomSettings.deleteConfirm':
		'确定要永久删除此工作室吗？所有会话、任务、目标和消息都将丢失。此操作不可撤销。',
	'roomSettings.deletePermanently': '永久删除',
	'roomSettings.saveChanges': '保存更改',
	'roomSettings.saving': '保存中...',
	'roomSettings.saved': '设置已保存',
	'roomSettings.saveFailed': '保存设置失败',
	'roomSettings.maxReviewRounds': '最大审查轮数',
	'roomSettings.maxReviewRoundsDesc': '任务失败前的最大审查迭代次数。',
	'roomSettings.maxConcurrentTasks': '最大并发任务数',
	'roomSettings.maxConcurrentTasksDesc': '并行运行的最大任务数。下次调度时生效。',
	'roomSettings.maxPlanningRetries': '最大规划重试次数',
	'roomSettings.maxPlanningRetriesDesc':
		'目标规划失败后自动重试的次数，超过后将提交人工审核。0 表示不自动重试。',
	'roomSettings.allowedModels': '可用模型',
	'roomSettings.allowedModelsDesc':
		'启用此工作室可用的模型。默认模型仅限于此列表。',
	'roomSettings.selectAll': '全选',
	'roomSettings.selectNone': '全不选',
	'roomSettings.loadingModels': '加载模型中...',
	'roomSettings.noModels': '暂无可用模型',
	'roomSettings.defaultModel': '默认模型',
	'roomSettings.defaultModelDesc':
		'此工作室新会话的默认模型。留空则使用系统默认。',
	'roomSettings.useSystemDefault': '使用系统默认',
	'roomSettings.default': '默认',
	'roomSettings.workspacePaths': '工作区路径',
	'roomSettings.workspacePathsDesc':
		'此工作室的允许工作区路径。代理可以操作这些目录中的文件。',
	'roomSettings.noWorkspacePaths': '未配置工作区路径',
	'roomSettings.setDefault': '设为默认',
	'roomSettings.addDescriptionPlaceholder': '添加描述（可选）',
	'roomSettings.pathPlaceholder': '/路径/到/工作区',
	'roomSettings.descriptionPlaceholder': '此路径的描述（可选）',
	'roomSettings.addPath': '添加路径',
	'roomSettings.folderPickerFailed': '打开文件夹选择器失败',
	'roomSettings.archiveRoom': '归档工作室',
	'roomSettings.archiveRoomLabel': '归档工作室',

	// Room toast messages
	'room.archivedSuccess': '工作室已归档',
	'room.deletedSuccess': '工作室已永久删除',

	// Daemon status
	'daemon.connected': '守护进程：已连接',
	'daemon.connecting': '守护进程：连接中...',
	'daemon.reconnecting': '守护进程：重连中...',
	'daemon.offline': '守护进程：离线',
	'daemon.error': '守护进程：错误',

	// Connection overlay
	'connection.reconnectingLabel': '重新连接中...',

	// Tasks extra
	'tasks.view': '查看',
	'tasks.deps': '依赖：',

	// Create room
	'createRoom.createRoom': '创建工作室',
	'createRoom.failed': '创建工作室失败',

	// Room Sessions
	'roomSessions.empty': '此工作室暂无会话',
	'roomSessions.emptyDesc':
		'当任务分配给 AI 代理时，会话会自动创建。',

	// Global Settings
	'settings.title': '全局设置',
	'settings.subtitle': '新会话的默认配置',
	'settings.general': '通用',
	'settings.providers': '服务商',
	'settings.mcpServers': 'MCP 服务器',
	'settings.usage': '用量',
	'settings.about': '关于',
	'settings.language': '语言',
	'settings.languageDesc': '界面语言',
	'settings.defaultModel': '默认模型',
	'settings.defaultModelDesc': '新会话使用的模型',
	'settings.permissionMode': '权限模式',
	'settings.permissionModeDesc': 'Claude 请求权限的方式',
	'settings.thinkingLevel': '默认思考等级',
	'settings.thinkingLevelDesc': '新会话的思考预算',
	'settings.autoScroll': '自动滚动',
	'settings.autoScrollDesc': '自动滚动到新消息',
	'settings.showArchived': '显示已归档会话',
	'settings.showArchivedDesc': '在列表中显示已归档的会话',

	// Connection
	'connection.connected': '已连接',
	'connection.connecting': '连接中...',
	'connection.reconnecting': '重新连接中...',
	'connection.failed': '连接失败',
	'connection.offline': '离线',
	'connection.failedTitle': '连接失败',
	'connection.failedDesc': '多次尝试后仍无法建立连接。',
	'connection.reconnect': '重新连接',
	'connection.refreshPage': '刷新页面',
	'connection.persistHint':
		'如果问题持续存在，请检查网络连接或尝试重启服务器。',

	// Chat
	'chat.newSession': '新建会话',
	'chat.tools': '工具',
	'chat.sessionInfo': '会话信息',
	'chat.exportChat': '导出聊天',
	'chat.resetAgent': '重置代理',
	'chat.archiveSession': '归档会话',
	'chat.deleteChat': '删除聊天',
	'chat.notConnected': '未连接到服务器，请稍候...',
	'chat.sessionCreated': '会话创建成功',
	'chat.connectionLost': '连接已断开，请重试。',
	'chat.createFailed': '创建会话失败',

	// Error
	'error.details': '错误详情',
	'error.whatToTry': '你可以尝试：',
	'error.technicalDetails': '技术详情',
	'error.copyReport': '复制错误报告',
	'error.copied': '已复制！',

	// Common UI
	'common.goHome': '返回首页',
	'common.enter': '进入',
	'common.unknown': '未知',
	'common.sessionOne': '{count} 个会话',
	'common.sessionOther': '{count} 个会话',
	'common.reviewOne': '{count} 个待审核',
	'common.reviewOther': '{count} 个待审核',
	'common.updated': '更新于 {time}',
	'common.timeJustNow': '刚刚',
	'common.timeMinutes': '{count} 分钟前',
	'common.timeHours': '{count} 小时前',
	'common.timeDays': '{count} 天前',

	// Chat dialogs
	'chat.deleteTitle': '删除聊天',
	'chat.deleteConfirm': '确定要删除此聊天会话吗？此操作不可撤销。',
	'chat.rewindTitle': '回退对话',
	'chat.rewindBeforeMessage': '这将回退对话到此消息之前。选择要恢复的内容：',
	'chat.rewindToPoint': '这将回退对话到选定的位置。选择要恢复的内容：',
	'chat.rewindFilesAndConversation': '文件和对话',
	'chat.rewindFilesOnly': '仅文件',
	'chat.rewindConversationOnly': '仅对话',
	'chat.rewindCannotUndo': '此操作不可撤销。',
	'chat.rewinding': '回退中...',
	'chat.rewind': '回退',

	// Archive confirm
	'archive.confirmTitle': '确认归档',
	'archive.uncommittedChanges': '此工作树有 {count} 个未提交的更改：',
	'archive.commitsLostWarning': '移除工作树后这些提交将丢失。是否继续？',
	'archive.archiving': '归档中...',
	'archive.archiveAnyway': '仍然归档',

	// Lobby
	'lobby.title': 'Neo 大厅',
	'lobby.subtitle': '你的代理指挥中心',
	'lobby.recentSessions': '最近会话',
	'lobby.failedToLoad': '加载大厅失败',

	// Chat header
	'chat.resetting': '重置中...',
	'chat.session': '会话',
	'chat.newSessionTitle': '新建会话',
	'chat.totalTokens': '总 Token 数',
	'chat.sessionOptions': '会话选项',
	'chat.worktreeTooltip': '使用隔离的 git 工作树',

	// Input actions
	'input.notConnected': '未连接',
	'input.moreOptions': '更多选项',
	'input.autoScroll': '自动滚动',
	'input.rewindMode': '回退模式',
	'input.exitRewindMode': '退出回退模式',
	'input.attachImage': '附加图片',
	'input.dropImagesHere': '拖放图片到此处',
	'input.supportedFormats': 'PNG、JPG、GIF 或 WebP',
	'input.removeAttachment': '移除附件',
	'input.stopGeneration': '停止生成 (Esc)',
	'input.stopGenerationLabel': '停止生成',
	'input.sendMessage': '发送消息',
	'input.chatWithCoordinator': '与工作室协调器对话...',
	'input.askOrMake': '提问或创建任何内容...',
	'input.queueNow': '当前',
	'input.queueNext': '下一轮',
	'input.morePending': '还有 {count} 条待处理',
	'input.moreQueued': '还有 {count} 条排队中',

	// Session status bar
	'status.coordinatorMode': '协调器模式',
	'status.coordinatorEnabled': '协调器模式（已启用）',
	'status.coordinatorDisabled': '协调器模式（已禁用）',
	'status.sandboxMode': '沙盒模式',
	'status.sandboxEnabled': '沙盒模式（已启用）',
	'status.sandboxDisabled': '沙盒模式（已禁用）',
	'status.switchModel': '切换模型',
	'status.modelName': '模型：{name}',
	'status.switchModelName': '切换模型（{name}）',
	'status.selectModel': '选择模型',
	'status.current': '（当前）',
	'status.thinkingLevel': '思考等级',
	'status.thinking': '思考：{level}',
	'status.autoScrollEnabled': '自动滚动（已启用）',
	'status.autoScrollDisabled': '自动滚动（已禁用）',
	'status.scrollToBottom': '滚动到底部',

	// Context usage
	'context.clickForDetails': '点击查看上下文详情',
	'context.dataLoading': '上下文数据加载中...',
	'context.usage': '上下文使用量',
	'context.contextWindow': '上下文窗口',
	'context.breakdown': '详细分类',
	'context.model': '模型：',

	// Error banner
	'error.viewDetails': '查看详情',
	'error.dismiss': '关闭错误',

	// Task view
	'task.loadingTask': '加载任务中…',
	'task.notFound': '未找到任务',
	'task.backToRoom': '← 返回工作室',
	'task.failedToApprove': '批准任务失败',
	'task.failedToSendFeedback': '发送反馈失败',
	'task.failedToSendMessage': '发送消息失败',
	'task.awaitingReview': '等待你的审核',
	'task.reviewHint': '审核 PR 后批准或提供反馈',
	'task.approving': '批准中…',
	'task.approve': '✓ 批准',
	'task.feedbackPlaceholder': '或发送反馈以请求更改… (⌘↵ 发送)',
	'task.leaderPlaceholder': '向 Leader 发送消息… (⌘↵ 发送)',
	'task.workerRunning': 'Worker 正在运行 — 等待 Leader 审核',
	'task.noActiveGroup': '没有活跃的代理组',
	'task.waitingForRuntime': '等待运行时接收此任务。',
	'task.taskCompleted': '此任务已完成。',
	'task.taskFailed': '此任务已失败。',
	'task.taskReview': '此任务正在等待人工审核。',
	'task.taskDraft': '此任务是草稿，尚未安排执行。',
	'task.taskCancelled': '此任务已取消。',
	'task.noGroupSpawned': '尚未创建代理组。',
	'task.taskInfo': '任务信息',
	'task.taskId': '任务 ID：',
	'task.groupId': '组 ID：',
	'task.worker': 'Worker：',
	'task.leader': 'Leader：',
	'task.workerWorktree': 'Worker 工作树：',
	'task.leaderWorktree': 'Leader 工作树：',
	'task.modelLabel': '模型：{model}',
	'task.dependsOn': '依赖：',
	'task.iteration': '第 {count} 次迭代',
	'task.disableAutoScroll': '禁用自动滚动',
	'task.enableAutoScroll': '启用自动滚动',
	'task.taskPrefix': '任务：{title}',
	'task.room': '工作室',
	'task.copiedToClipboard': '已复制！',
	'task.copyToClipboard': '复制到剪贴板',

	// Group state labels
	'task.state.awaitingWorker': 'Worker 运行中…',
	'task.state.awaitingLeader': 'Leader 审核中…',
	'task.state.awaitingHuman': '需要人工审核',
	'task.state.completed': '已完成',
	'task.state.failed': '已失败',

	// Room context panel
	'roomPanel.allRooms': '所有工作室',
	'roomPanel.newSession': '新建会话',
	'roomPanel.noTasks': '暂无任务',
	'roomPanel.pending': '{count} 个待处理',
	'roomPanel.active': '{count} 个进行中',
	'roomPanel.done': '{count} 个已完成',
	'roomPanel.roomDashboard': '工作室仪表盘',
	'roomPanel.roomAgent': '工作室代理',
	'roomPanel.noSessions': '暂无会话',

	// Toast messages
	'toast.rewindSuccess': '回退成功：{details}',
	'toast.rewindFailed': '回退失败：{error}',
	'toast.loadOlderFailed': '加载历史消息失败',
	'toast.connectionLost': '连接已断开。',
	'toast.workspaceModeFailed': '设置工作区模式失败',
	'toast.autoScrollFailed': '保存自动滚动设置失败',
	'toast.coordinatorFailed': '切换协调器模式失败',
	'toast.sandboxFailed': '切换沙盒模式失败',
	'toast.archivedToggleFailed': '切换归档会话显示失败',
	'toast.noSessionId': '响应中缺少 sessionId',
	'toast.sessionDeleted': '会话已删除',
	'toast.sessionDeleteFailed': '删除会话失败',
	'toast.modelAlreadyUsing': '已在使用 {name}',
	'toast.modelSwitched': '已切换到 {name}',
	'toast.modelSwitchFailed': '切换模型失败',
	'toast.contextSaved': '上下文已保存',
	'toast.agentConfigSaved': '代理配置已保存',
	'toast.saveFailed': '保存失败',
	'toast.copied': '已复制到剪贴板',
	'toast.copyFailed': '复制消息失败',
	'toast.toolOutputRemoved': '工具输出已移除，正在重新加载会话...',
	'toast.cannotDelete': '无法删除：缺少消息或会话 ID',
	'toast.settingUpdateFailed': '更新设置失败',
	'toast.providerAuthSuccess': '{name} 认证成功',
	'toast.providerAuthFailed': '启动 OAuth 流程失败',
	'toast.loginFailed': '登录失败',
	'toast.logoutSuccess': '已从 {name} 登出',
	'toast.logoutFailed': '登出失败',
	'toast.providerLoadFailed': '加载服务商状态失败',
	'toast.mcpLoadFailed': '加载 MCP 服务器失败',
	'toast.mcpToggleFailed': '{action}服务器失败',
	'toast.toolsConfigSaved': '工具配置已保存',
	'toast.toolsConfigFailed': '保存工具配置失败',
	'toast.toolsMinSource': '至少需要启用一个设置来源',
	'toast.taskReviewReady': '任务待审核：{title}',
	'toast.daemonConnectFailed': '连接守护进程失败',

	// Chat container
	'chat.failedToLoad': '加载会话失败',
	'chat.rewindingTitle': '正在回退对话...',
	'chat.rewindingDesc': '这可能需要一点时间',
	'chat.beginningOfConversation': '对话开始',
	'chat.noMessages': '暂无消息',
	'chat.noMessagesDesc': '开始与 Claude 对话，见证奇迹',

	// Lobby extra
	'lobby.newSession': '新建会话',
	'lobby.createRoom': '创建工作室',

	// Room context
	'roomContext.instructions': '指令',
	'roomContext.instructionsDesc':
		'自定义工作室代理的行为方式。编码规范、首选工具、工作流程准则等。',
	'roomContext.contextPlaceholder': '描述项目上下文、架构和目标...',
	'roomContext.instructionsPlaceholder': '添加工作室代理的行为准则...',

	// Goals editor extra
	'goals.deleteTitle': '删除目标',
	'goals.deleteConfirm': '确定要删除「{title}」吗？此操作不可撤销。',
	'goals.goalTitlePlaceholder': '输入目标标题...',
	'goals.goalDescPlaceholder': '描述目标...',
	'goals.linkTaskPlaceholder': '输入要关联的任务 ID...',
	'goals.selectModel': '选择模型',

	// Room dashboard extra
	'roomDashboard.agents': '代理',

	// MCP settings
	'mcp.loadingServers': '加载服务器中...',
	'mcp.enableAction': '启用',
	'mcp.disableAction': '禁用',

	// Tools modal
	'tools.title': '工具',

	// Question prompt
	'question.responsePlaceholder': '输入你的回复...',

	// Session list item
	'session.archivedTitle': '已归档会话',

	// New session modal
	'newSession.title': '新建会话',
	'newSession.workspaceLabel': '你想在哪里工作？',
	'newSession.selectPath': '选择最近的路径...',
	'newSession.or': '或',
	'newSession.pathPlaceholder': '输入工作区路径...',
	'newSession.browse': '浏览文件夹...',
	'newSession.browseSoon': '浏览功能即将推出',
	'newSession.assignRoom': '分配到工作室（可选）',
	'newSession.noRoom': '不分配',
	'newSession.createNewRoom': '+ 创建新工作室...',
	'newSession.createRoomTitle': '创建新工作室',
	'newSession.roomName': '工作室名称',
	'newSession.roomNamePlaceholder': '例如：网站开发',
	'newSession.roomDescLabel': '描述（可选）',
	'newSession.roomDescPlaceholder': '这个工作室用来做什么？',
	'newSession.createRoom': '创建工作室',
	'newSession.createSession': '创建会话',
	'newSession.pathRequired': '工作区路径不能为空',
	'newSession.roomNameRequired': '工作室名称不能为空',
	'newSession.createRoomUnavailable': '创建工作室不可用',
	'newSession.createSessionFailed': '创建会话失败',
	'newSession.createRoomFailed': '创建工作室失败',

	// Session actions extra
	'toast.sessionArchived': '会话已归档',
	'toast.agentReset': '代理已重置。',
	'toast.chatExported': '聊天已导出！',
	'toast.exportFailed': '导出聊天失败',
	'toast.notConnected': '未连接到服务器',
	'toast.stopFailed': '停止生成失败',
	'toast.sendArchived': '无法向已归档的会话发送消息',
	'toast.sendTimeout': '消息发送超时。',
	'toast.sendConnectionLost': '连接已断开。',
	'toast.sendRefresh': '连接已断开，请刷新页面。',

	// Room agent avatars
	'roomAgentAvatars.defaultModel': '默认模型',
	'roomAgentAvatars.manage': '管理代理',
	'roomAgentAvatars.add': '添加代理',

	// Agent settings popover
	'roomAgentPopover.model': '模型',
	'roomAgentPopover.subAgentClis': '子代理 CLI',
	'roomAgentPopover.subAgentModels': '子代理模型',
};
