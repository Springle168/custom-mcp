# AGENTS.md

本文件面向维护 `custom-mcp` 项目的 AI Coding Agent，作用范围为整个仓库。若本文件与用户当前明确指令冲突，以用户指令优先。

## 项目上下文

- 这是一个 TypeScript / Node.js MCP 工具集，通过 Streamable HTTP 协议提供工具能力。
- 开始做任何事情前，先阅读 `docs/DEVELOPMENT.md`。
- 工具级细节优先参考 `docs/tools/` 下对应文档。
- 根目录 `config.json` 是本地运行配置，可能包含个人路径；除非任务明确需要，否则优先参考 `config.example.json`。
- 常见入口：`src/index.ts` 负责 HTTP 与 MCP 会话，`src/tools/` 负责工具定义与 handler，`src/engine/` 放纯算法，`src/utils/` 放基础设施。

## 操作边界

- 保持改动小而聚焦，不顺手重构无关代码，不修复与任务无关的问题。
- 禁止未经用户明确允许的情况下读取或修改 `package-lock.json`、`node_modules/`、`logs/`、`dist/`、`config.json`。
- 禁止未经用户明确允许的情况下读取、修改或执行任何工作区外的文件或程序。
- 不要自行创建临时目录、迁移路径、调用工作区外部程序或安装依赖；确有必要时先说明原因并征得用户同意。
- 不要泄露、泛化或覆盖用户本地配置中的私有路径与环境信息。
- 修改前用只读方式确认工作树状态；已有未提交或未跟踪内容视为用户资产，不得覆盖、删除或重置。

## 协作与澄清

- 优先通过只读探查解决事实性问题；当偏好、取舍或高影响不确定性无法从仓库确认时，向用户提问。
- 需要向用户提问时，优先使用当前宿主或环境提供的内置提问能力；不适用或不可用时，再使用普通提问工具（如 `ask_user`）或直接提问。
- 只有用户明确表示可以使用 sub-agent 时才创建；创建前说明任务目标、只读或可写边界、输出要求，默认使用 `fork_context:false`，不未经要求指定特定模型或者思考深度。
- sub-agent 适合独立、可并行的调查、验证或小范围修改；不要把阻塞主线、高耦合或需要关键判断的任务外包。
- 若授权 sub-agent 修改文件，必须指定明确且互不重叠的写入范围，并在汇总时说明其产出和未采纳建议。

## 代码与工具约定

- 新增工具时，默认在 `src/tools/` 新建单独文件，默认导出 `MCPTool`，并在 `src/tools/index.ts` 注册。
- 添加或调整工具后，同步维护 `docs/tools/` 中的工具文档；必要时更新 `docs/DEVELOPMENT.md` 的工具列表或开发说明。
- `src/engine/` 应保持纯算法、无 I/O；跨工具复用的文件、路径、日志、Gradle 等基础能力放在 `src/utils/`。
- 保持现有 TypeScript 风格：ESM / NodeNext、严格类型、相对导入使用 `.js` 后缀、避免不必要的 `any`。
- 工具 schema 的 `description` 是给 AI 看的 prompt，应简洁说明能力边界、参数约束、常见误用和与其他工具的配合方式。
- 若 schema 含嵌套对象数组，必须把嵌套字段语义上提到顶层 `description`，以规避 Android Studio 转换层丢失嵌套描述的问题（此约定只在用户明确表示正在进行 Android Studio 工具的开发时生效）。

## 文件与并发安全

- 文件类工具必须通过 `resolvePath()` 和 `validatePathAccess()` 校验路径在 `rootDir` 范围内。
- 任何写文件工具都必须使用 `withFileLock()` 包裹写入流程；只读工具不需要加锁。
- 文本处理遵守 `lineEnding` 配置：读取后可统一为 `\n` 处理，写回时恢复目标行尾策略。
- 读取或处理文件内容前应考虑二进制文件检测，避免把二进制内容当文本处理。
- 错误返回应设置 `isError: true`，并给出能帮助 AI 自我修正的原因和下一步建议。

## 注释与文档

- 注释只在能提升维护性时添加；优先解释“为什么”，不要复述代码“做了什么”。
- 适合写注释的场景包括但不限于：MCP / Android Studio / Windows 行为限制、竞态或并发保护、路径安全、失败恢复、兼容性权衡、非显然分支和 workaround。
- 不要为了满足本文件而添加行尾或逐行解释式 inline 注释；若确有必要，优先使用模块、函数、类型或短块注释说明关键原因。
- 核心运行时组件、重要工具 handler、复杂算法或关键类型在语义不够自明时，应补充必要的 JSDoc 或说明文档。
- `TODO` / `FIXME` 必须写明原因和预期后续动作，禁止留下 `TODO: fix this` 这类占位内容。
- 新增专题文档仅在有明确维护价值时创建，默认放在 `docs/` 或 `docs/tools/` 的合适位置。

## 验证方式

- TypeScript 编译：`npm run build`。
- 单个脚本测试：`npx tsx test/<file>.ts`。
- 在 Windows / PowerShell 下执行 `npx tsx test/<file>.ts` 时，需要显式加 `powershell.exe -ExecutionPolicy Bypass -Command ...`，或者改用 `cmd /c npx tsx test/<file>.ts`。`require_escalated` 提权无法绕过 `ExecutionPolicy`。
- Android 构建相关测试集中在 `test/android-build/`。其中 timeout / launcher 测试依赖 Windows 进程树和 `gradlew.bat` 启动行为，需要提权跑测试验证。
- 不要运行会改写源码、文档或快照的格式化/生成命令，除非用户明确要求或当前任务必须如此。

## 工具调用指导

- 当一次性读取大量文件时，优先使用 `read_many_files` 工具的 `shallow_read` 功能，预防可能发生的截断问题。
- 鼓励并行调用工具。

## Git 使用规则

- 默认允许只读 Git 操作：`git status`、`git diff`、`git log`、`git blame`。
- 除非用户特殊要求，否则 Git 操作不得输出带 作者名 或者 作者邮箱 的内容。
- 未经用户明确同意和授权，不要执行 `git add`、`git commit`、`git branch`、`git tag` 或其他会改变仓库状态的 Git 操作。
- 如果用户明确允许或要求创建提交：
  - 按需读取：当下一步是进行提交时，阅读 `docs/commit-guidelines.md` 并遵循其中的指引；避免不必要的提前读取。
  - 提交修改：基于实际改动生成提交信息。
- 在沙箱或受限权限环境中创建提交时，必须通过当前环境的正式提权流程运行 `git commit`，因为提交需要写入 `.git/`（如 `.git/index.lock`）。
- 未经用户明确授权，不要执行历史改写或破坏性操作，包括但不限于 `git commit --amend`、`git rebase`、`git reset`、`git clean`、`git stash`、`git cherry-pick`。
- 未经用户明确授权，不要执行远端操作，包括但不限于 `git push`、`git pull`、`git fetch` 或 force-push。
- 会话开始时已有的提交历史是受保护基线；不得改写、压缩、删除或重排。
