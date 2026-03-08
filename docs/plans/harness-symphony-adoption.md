# Harness / Symphony 能力借鉴方案

> 来源：OpenAI [Harness Engineering](https://openai.com/index/harness-engineering/) + [Symphony](https://github.com/openai/symphony)
> 原则：只借鉴对 NeoKai 有实际价值的能力，不照搬不适用的部分

---

## P0：上下文分层 + 约束机械化

### P0-A：CLAUDE.md 分层（开发体验）

**问题**：当前 `CLAUDE.md` 199 行，E2E 规则占 ~50 行，架构细节占 ~40 行。每次 Claude Code 交互都加载全部内容，大部分与当前任务无关，挤占了真正有用的上下文空间。

**来源**：Harness 的"给 agent 一张地图，不是一本千页手册"原则。

**方案**：

1. **根目录 `CLAUDE.md` 精简到 ~100 行**，只保留：
   - 项目概述（5行）
   - 技术栈（5行）
   - 分包结构（10行）
   - 常用命令（15行）
   - 代码风格要点（10行）
   - 环境配置（5行）
   - 指向子目录的指针（5行）
   - 分支策略和提交规范（10行）

2. **创建包级 `CLAUDE.md`**（Claude Code 原生支持目录级指令）：
   - `packages/e2e/CLAUDE.md` — E2E 测试规则（当前 CLAUDE.md 136-182 行的内容）
   - `packages/daemon/CLAUDE.md` — 后端架构细节、测试组织、在线测试说明
   - `packages/web/CLAUDE.md` — 前端约定（Preact/Signals 模式、island 组件）

3. **保留 `docs/` 作为深层参考**：
   - 当前 `docs/design/`、`docs/adr/`、`docs/plans/` 结构已经合理
   - 根 `CLAUDE.md` 加一行指针：`Architecture details → docs/design/, ADRs → docs/adr/`

**验收标准**：
- 根 `CLAUDE.md` ≤ 120 行
- 在 `packages/e2e/` 下工作时，Claude Code 自动加载 E2E 规则而非全局
- 在 `packages/web/` 下工作时，不会看到 E2E 规则

**预估成本**：2-3 小时

---

### P0-B：E2E 约束 CI 检查（质量保障）

**问题**：CLAUDE.md 中的 E2E 规则（禁止 `hub.request()`、禁止 `window.sessionStore` 等）纯靠 agent 阅读文档后自觉遵守。人类 PR review 也容易遗漏。

**来源**：Harness 的"能机械化执行的规则就不要靠文档"。自定义 lint 错误信息注入 agent 上下文。

**方案**：

在 CI 中添加一个轻量检查脚本 `scripts/check-e2e-rules.sh`：

```bash
#!/bin/bash
set -euo pipefail

ERRORS=0
E2E_TESTS="packages/e2e/tests"

# 排除的基础设施文件（允许使用 RPC 的文件）
INFRA_EXCLUDE=(
  "global-setup.ts"
  "global-teardown.ts"
  "fixtures/index.ts"
  "helpers/"
)

build_exclude() {
  local args=""
  for pat in "${INFRA_EXCLUDE[@]}"; do
    args="$args --exclude=$pat"
  done
  echo "$args"
}

EXCLUDE=$(build_exclude)

# 规则 1：E2E 测试文件中不得直接调用 hub.request / hub.event
if grep -r "hub\.request\|hub\.event" $E2E_TESTS $EXCLUDE --include="*.e2e.ts" -l 2>/dev/null; then
  echo "ERROR: E2E tests must not use direct RPC calls (hub.request/hub.event)."
  echo "FIX: Use UI interactions instead. See packages/e2e/CLAUDE.md for rules."
  ERRORS=$((ERRORS + 1))
fi

# 规则 2：不得读取内部 store 做断言
if grep -r "window\.sessionStore\|window\.globalStore\|window\.appState\|window\.__stateChannels" \
  $E2E_TESTS $EXCLUDE --include="*.e2e.ts" -l 2>/dev/null; then
  echo "ERROR: E2E tests must not access internal state for assertions."
  echo "FIX: Assert on visible DOM state instead."
  ERRORS=$((ERRORS + 1))
fi

# 规则 3：不得使用 setOffline
if grep -r "setOffline" $E2E_TESTS --include="*.e2e.ts" -l 2>/dev/null; then
  echo "ERROR: Use closeWebSocket()/restoreWebSocket() helpers instead of setOffline()."
  ERRORS=$((ERRORS + 1))
fi

exit $ERRORS
```

**集成点**：
- 加入 `.github/workflows/main.yml` 的 PR 检查
- 加入 `scripts/git-hooks/pre-commit`（仅当 e2e 文件变更时运行）

**验收标准**：
- 违规的 E2E 测试在 CI 中被自动拒绝
- 错误信息包含修复指引（FIX 行），agent 看到后知道怎么改

**预估成本**：1-2 小时

---

## P1：任务韧性（Stall 检测 + 退避重试）

### P1-A：Stall 检测

**问题**：当前 `SessionObserver` 只检测 agent 到达终态（idle/waiting_for_input/interrupted）。如果 agent 卡住（死循环、网络挂起、API 超时），session group 会永远停留在 `awaiting_worker` 或 `awaiting_leader` 状态，占用并发槽。

**来源**：Symphony 的 `stall_timeout_ms` — 无 Codex 活动超时后自动终止并重试。

**方案**：

1. **在 `SessionGroup` metadata 中添加 stall 跟踪字段**：
   ```typescript
   interface SessionGroupMetadata {
     // ... existing fields
     lastActivityAt: number;      // 最近一次 agent 输出的时间戳
     stallTimeoutMs: number;      // 默认 300000 (5分钟)，可配置
   }
   ```

2. **在 `SessionObserver` 中增加活动追踪**：
   - 订阅 session 的消息事件（agent 输出文本、工具调用）
   - 每次活动更新 `lastActivityAt`

3. **在 `RoomRuntime.tick()` 中增加 stall 检查**：
   ```
   for each active group:
     if now - lastActivityAt > stallTimeoutMs:
       log warning "Group {id} stalled for {duration}"
       interrupt worker/leader session
       mark group as failed with error "stalled"
       task retry will be triggered (see P1-B)
   ```

4. **前端通知**：stall 发生时通过 `room.task.update` 事件通知 UI，显示 "Task stalled, retrying..."

**关键设计**：
- Stall 超时可在 Room settings 中配置（默认 5 分钟）
- `awaiting_human` 状态不检查 stall（人类响应时间不可预测）
- Rate limit 期间不检查 stall（已知等待）

**预估成本**：2-3 天

---

### P1-B：指数退避自动重试

**问题**：当前 `retryTask()` 是手动触发的（用户点按钮）。任务失败后需要人工介入才能重跑。同一个错误可能重复出现（如 API 限流），立即重试只会再次失败。

**来源**：Symphony 的指数退避公式 `min(base * 2^(attempt-1), max_backoff)`。

**方案**：

1. **在 `NeoTask` 中添加重试相关字段**：
   ```typescript
   interface NeoTask {
     // ... existing fields
     retryCount: number;          // 当前重试次数，默认 0
     maxRetries: number;          // 最大重试次数，默认 3
     nextRetryAt: number | null;  // 下次重试时间戳
     retryPolicy: 'auto' | 'manual' | 'none';  // 重试策略
   }
   ```

2. **失败时自动调度重试**：
   ```typescript
   // TaskGroupManager 中，当 group 进入 failed 状态时：
   if (task.retryPolicy === 'auto' && task.retryCount < task.maxRetries) {
     const backoffMs = Math.min(
       10_000 * Math.pow(2, task.retryCount),  // 10s, 20s, 40s, 80s
       task.maxRetryBackoffMs ?? 120_000        // 上限 2 分钟
     );
     task.retryCount++;
     task.nextRetryAt = Date.now() + backoffMs;
     task.status = 'pending';  // 回到 pending，等待 tick 调度
   }
   ```

3. **tick() 中检查 `nextRetryAt`**：
   ```
   for each pending task with nextRetryAt:
     if now >= nextRetryAt:
       clear nextRetryAt
       eligible for scheduling (normal flow)
   ```

4. **不同失败原因的策略**：

   | 失败原因 | 重试策略 |
   |---------|---------|
   | Stall 超时 | 自动重试（可能是临时问题） |
   | API rate limit | 自动重试（等到 reset 时间后） |
   | Agent 报告任务失败 | 不自动重试（agent 判断不可完成） |
   | Session lost (crash) | 自动重试（恢复机制） |
   | 人工取消 | 不重试 |

5. **前端显示**：
   - 任务卡片显示 "Retry 2/3 in 40s..."
   - 倒计时结束后自动重跑
   - 用户可随时手动触发立即重试或取消自动重试

**与现有 `retryTask()` 的关系**：保留手动重试入口，新增自动重试逻辑。手动重试重置 `retryCount` 为 0。

**预估成本**：3-4 天

---

## P2：Session / Room 模板

**问题**：用户创建 session 或 room 时每次从零配置。做相似类型的工作（修 bug、写测试、重构、code review）反复设置相同的模型、system prompt、工具等。

**来源**：Symphony 的 `WORKFLOW.md`（YAML 前置 + prompt 模板）。

**方案**：

### 数据模型

```typescript
interface SessionTemplate {
  id: string;
  name: string;                    // "Bug Fix", "Code Review", "Refactor"
  description?: string;
  scope: 'session' | 'room';      // 适用于单 session 还是 room
  config: {
    model?: string;                // 默认模型
    systemPrompt?: string;         // 预设 system prompt，支持 {{变量}}
    tools?: string[];              // 预启用的 MCP server
    maxTokens?: number;
    temperature?: number;
  };
  // Room 专用
  roomConfig?: {
    maxConcurrentGroups?: number;
    maxFeedbackIterations?: number;
    stallTimeoutMs?: number;
    retryPolicy?: 'auto' | 'manual' | 'none';
    maxRetries?: number;
  };
  // 变量定义（用户创建时填写）
  variables?: Array<{
    name: string;                  // {{description}}, {{file_path}}
    label: string;                 // 显示名
    type: 'text' | 'textarea' | 'select';
    required: boolean;
    options?: string[];            // select 类型的选项
    default?: string;
  }>;
  builtIn: boolean;               // 系统内置 vs 用户自建
  createdAt: number;
  updatedAt: number;
}
```

### 内置模板示例

```yaml
# Bug Fix
name: Bug Fix
scope: session
config:
  systemPrompt: |
    复现并修复以下 bug：{{description}}
    修复后确保：
    1. 相关测试通过
    2. 无 TypeScript 类型错误
    3. 无 lint 错误
variables:
  - name: description
    label: Bug 描述
    type: textarea
    required: true

# Code Review
name: Code Review
scope: session
config:
  systemPrompt: |
    Review the following PR/changes: {{target}}
    Focus on: correctness, security, performance, readability.
    Provide actionable feedback.
variables:
  - name: target
    label: PR URL or branch name
    type: text
    required: true

# Feature Development (Room)
name: Feature Development
scope: room
config:
  model: claude-sonnet-4-6
  systemPrompt: |
    你是一个功能开发团队。目标：{{goal}}
roomConfig:
  maxConcurrentGroups: 2
  maxFeedbackIterations: 3
  retryPolicy: auto
  maxRetries: 2
variables:
  - name: goal
    label: 功能目标
    type: textarea
    required: true
```

### 实现要点

1. **存储**：SQLite `session_templates` 表，config/variables 存 JSON
2. **UI**：
   - 新建 session/room 时显示模板选择器（网格卡片）
   - 选择模板后弹出变量填写表单
   - "保存为模板" 按钮（从现有 session 配置创建）
3. **模板渲染**：简单的 `{{var}}` 替换，不需要复杂模板引擎
4. **导入/导出**：支持 JSON 格式导入导出模板

**预估成本**：4-5 天

---

## P3：任务生命周期钩子

**问题**：agent 完成工作后，验证步骤（测试、类型检查、lint）要么人工执行，要么依赖 agent 自己记得跑。不同任务需要不同的验证流程。

**来源**：Symphony 的 `hooks`（`after_create`、`before_run`、`after_run`、`before_remove`） + Harness 的"反馈循环"。

**方案**：

### 钩子类型

```typescript
interface TaskHook {
  event: 'before_run' | 'after_run' | 'on_fail' | 'on_complete';
  command: string;           // Shell 命令
  timeoutMs: number;         // 默认 60000
  failBehavior: 'block' | 'warn' | 'ignore';
  // block: 阻止任务继续（before_run 阻止启动，after_run 标记验证失败）
  // warn: 记录警告但继续
  // ignore: 静默继续
}
```

### 执行时机

| 钩子 | 触发点 | 用途 |
|------|--------|------|
| `before_run` | 任务从 pending → in_progress 之前 | 前置检查：typecheck 通过才启动 agent |
| `after_run` | Worker 到达终态后，路由给 Leader 之前 | 自动验证：跑测试、lint、构建 |
| `on_fail` | 任务进入 failed 状态 | 清理：回滚 worktree、通知 |
| `on_complete` | 任务进入 completed 状态 | 后处理：自动提 PR、部署预览 |

### 实现要点

1. **配置层级**：
   - Room 级默认钩子（所有任务继承）
   - 任务级覆盖（单个任务可定制）
   - 模板（P2）中可预设钩子

2. **执行环境**：
   - 在任务的 worktree 目录下执行
   - 注入环境变量：`NEOKAI_TASK_ID`、`NEOKAI_ROOM_ID`、`NEOKAI_WORKTREE_PATH`
   - stdout/stderr 捕获并附加到任务日志

3. **反馈给 agent**：
   - `after_run` 的输出注入到 Leader 的上下文中
   - Leader 看到 "Tests failed: 3 failures in auth.test.ts" 可以指导 Worker 修复
   - 这形成了 Harness 所说的"反馈循环"

4. **与 Claude Code hooks 的关系**：
   - Claude Code 本身有 hooks 机制（tool 级别）
   - NeoKai 的钩子在**任务级别**，更高层次
   - 不冲突，互补

**预估成本**：4-5 天

---

## P4：架构漂移检测

**问题**：随着 agent 持续生成代码，模式会被无意复制和变异。当前没有机制检测分包间的依赖违规或模式偏离。

**来源**：Harness 的严格架构层次（Types → Config → Repo → Service → Runtime → UI）+ 自定义 linter 机械化执行 + "garbage collection" 定期清理。

**方案**：

### 4A：包依赖方向检查

NeoKai 的包依赖规则（已在 CLAUDE.md 和 tsconfig 中隐含）：

```
shared ← daemon（shared 不依赖 daemon）
shared ← web（shared 不依赖 web）
daemon ↛ web（daemon 不依赖 web）
web ↛ daemon（web 不依赖 daemon，通过 MessageHub 通信）
cli → daemon（cli 依赖 daemon）
e2e 独立（仅通过浏览器交互）
```

**检查脚本** `scripts/check-package-deps.sh`：

```bash
#!/bin/bash
set -euo pipefail
ERRORS=0

# shared 不得 import daemon 或 web
if grep -r "from '@neokai/daemon\|from '@neokai/web\|require.*@neokai/daemon\|require.*@neokai/web" \
  packages/shared/src/ --include="*.ts" -l 2>/dev/null; then
  echo "ERROR: packages/shared must not import from daemon or web"
  ERRORS=$((ERRORS + 1))
fi

# web 不得 import daemon
if grep -r "from '@neokai/daemon\|require.*@neokai/daemon" \
  packages/web/src/ --include="*.ts" --include="*.tsx" -l 2>/dev/null; then
  echo "ERROR: packages/web must not import from daemon"
  ERRORS=$((ERRORS + 1))
fi

# daemon 不得 import web
if grep -r "from '@neokai/web\|require.*@neokai/web" \
  packages/daemon/src/ --include="*.ts" -l 2>/dev/null; then
  echo "ERROR: packages/daemon must not import from web"
  ERRORS=$((ERRORS + 1))
fi

exit $ERRORS
```

加入 CI（`bun run check` 步骤后）和 pre-commit hook。

### 4B：代码健康度指标（轻量版质量评分）

Harness 有完整的质量评分体系，对 NeoKai 来说过重。但可以做一个轻量版：

```bash
# scripts/code-health.sh — 不阻断 CI，仅报告
echo "=== Code Health Report ==="

# 文件大小警告（>500 行的文件列表）
echo "Large files (>500 lines):"
find packages/*/src -name "*.ts" -o -name "*.tsx" | while read f; do
  lines=$(wc -l < "$f")
  if [ "$lines" -gt 500 ]; then
    echo "  $f: $lines lines"
  fi
done

# TODO/FIXME/HACK 计数
echo "Tech debt markers:"
echo "  TODO:  $(grep -r 'TODO' packages/*/src --include='*.ts' --include='*.tsx' -c 2>/dev/null | awk -F: '{s+=$2}END{print s}')"
echo "  FIXME: $(grep -r 'FIXME' packages/*/src --include='*.ts' --include='*.tsx' -c 2>/dev/null | awk -F: '{s+=$2}END{print s}')"
echo "  HACK:  $(grep -r 'HACK' packages/*/src --include='*.ts' --include='*.tsx' -c 2>/dev/null | awk -F: '{s+=$2}END{print s}')"

# 重复代码模式检测（简化版：重复的 import 块）
echo "Duplicate utility patterns: (manual review needed)"
```

**集成**：CI 中作为信息输出（不阻断），每次 PR 可以看到健康趋势。

**预估成本**：
- 4A 包依赖检查：半天
- 4B 健康度报告：1 天

---

## P5：渐进式上下文披露

**问题**：当 agent 处理复杂任务时（如跨包重构），需要理解整个系统架构，但当前没有结构化的方式让 agent 逐步深入。

**来源**：Harness 的"渐进式披露"——agent 从小而稳定的入口开始，被教会去哪里找更多信息，而非一次性灌入所有内容。

**方案**：

### 5A：结构化架构文档

创建 `docs/ARCHITECTURE.md`（面向 agent 的架构地图）：

```markdown
# Architecture Map

## Package Dependency Flow
cli → daemon → shared ← web

## Key Entry Points
- CLI startup: packages/cli/src/index.ts
- Daemon bootstrap: packages/daemon/src/app.ts (DaemonApp)
- Web entry: packages/web/src/index.ts

## Core Subsystems
| Subsystem | Location | Entry File | Description |
|-----------|----------|------------|-------------|
| Agent | daemon/src/lib/agent/ | agent-session.ts | Agent lifecycle |
| Room Runtime | daemon/src/lib/room/runtime/ | room-runtime.ts | Task orchestration |
| MessageHub | shared/src/message-hub/ | hub.ts | RPC + pub/sub |
| State | daemon/src/lib/session/ | state-manager.ts | Session state sync |
| RPC | daemon/src/lib/rpc-handlers/ | index.ts | All RPC endpoints |

## Data Flow
1. User action in web → MessageHub RPC → daemon handler
2. Daemon handler → business logic → state update
3. State update → MessageHub event → web subscriber → UI update

## When modifying:
- Adding RPC endpoint → see daemon/src/lib/rpc-handlers/README
- Adding UI component → see packages/web/CLAUDE.md
- Changing shared types → check both daemon and web consumers
- Adding E2E test → see packages/e2e/CLAUDE.md
```

### 5B：子系统级 README

在关键目录添加简短 README（不是给人看的文档，是给 agent 的导航）：

- `packages/daemon/src/lib/room/README.md` — Room 子系统概览、状态机、关键类
- `packages/daemon/src/lib/rpc-handlers/README.md` — RPC 注册模式、如何添加新端点
- `packages/shared/src/message-hub/README.md` — MessageHub 三层架构、初始化顺序

每个 README 控制在 30-50 行，只包含：
1. 这个目录做什么（2 行）
2. 关键文件列表（5-10 行）
3. 常见修改场景的指引（10-15 行）

### 5C：CLAUDE.md 中的指针

根 `CLAUDE.md` 添加：

```markdown
## Deep Dive
- Architecture overview → docs/ARCHITECTURE.md
- Room Runtime design → docs/design/room-runtime-spec.md
- ADRs → docs/adr/
- Implementation plans → docs/plans/
```

Claude Code 遇到需要深入了解的场景时，会主动去读这些文件。

**预估成本**：2-3 天

---

## 总览

| 优先级 | 事项 | 类型 | 成本 | 核心价值 |
|--------|------|------|------|----------|
| **P0-A** | CLAUDE.md 分层 | 开发体验 | 2-3h | 每次 Claude Code 交互的上下文质量提升 |
| **P0-B** | E2E 约束 CI 检查 | 质量保障 | 1-2h | 消除反复违规，机械化执行规则 |
| **P1-A** | Stall 检测 | 产品能力 | 2-3d | Room 任务不会无限卡住 |
| **P1-B** | 指数退避自动重试 | 产品能力 | 3-4d | 临时失败自动恢复，减少人工干预 |
| **P2** | Session/Room 模板 | 产品能力 | 4-5d | 减少重复配置，标准化工作流 |
| **P3** | 任务生命周期钩子 | 产品能力 | 4-5d | 自动化验证闭环 |
| **P4-A** | 包依赖方向检查 | 质量保障 | 0.5d | 防止架构退化 |
| **P4-B** | 代码健康度报告 | 质量保障 | 1d | 趋势可见性 |
| **P5** | 渐进式上下文披露 | 开发体验 | 2-3d | agent 更高效地理解和导航代码库 |

**建议执行顺序**：P0-A → P0-B → P4-A → P5 → P1-A → P1-B → P2 → P3 → P4-B

理由：前四项（P0 + P4-A + P5）都是低成本高回报的基础设施改善，为后续功能开发奠定更好的 agent 协作基础。P1 之后的功能开发会因此更高效。
