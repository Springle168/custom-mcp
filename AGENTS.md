# AGENTS.md

本文件面向维护 `custom-mcp` 项目的 AI Agent，作用范围为整个仓库。若本文件与用户当前明确指令冲突，以用户指令优先。

## 项目上下文

- 这是一个 TypeScript / Node.js MCP 工具集，通过 Streamable HTTP 协议提供工具能力。
- 当任务目标涉及本项目的代码、配置、构建或测试时，请在操作前阅读 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 及与当前任务相关的文档。
- 根目录 `config.json` 是本地运行配置，可能包含个人路径；除非任务明确需要，否则优先参考 `config.example.json`。

## 操作边界

- 除非任务明确需要，否则保持改动小而聚焦，不顺手重构无关代码，不修复与任务无关的问题。
- **未经用户明确授权**：
  * 禁止主动查看或修改 `package-lock.json`、`node_modules/`、`logs/`、`dist/`、`config.json`。
  * 禁止读取或修改工作区外文件；禁止执行未知的、用户本地私有的或与任务无关的工作区外程序。
  * 例外：为完成本仓库任务所需的常规开发命令（如 git、npm、npx、node、powershell.exe、cmd）按本文“验证方式”和“Git 使用规则”执行。
  * 禁止为绕过路径、安全或并发约束而创建临时目录或迁移路径。
  * 禁止主动安装依赖。
  * 确有必要时先说明原因并征得用户同意。
- 禁止泄露或覆盖用户本地配置中的私有路径与环境信息。
- 修改前用只读方式确认工作树状态；已有未提交或未跟踪内容视为用户资产，未经用户明确授权时不得覆盖、删除或重置它们。

## 协作与澄清

- 优先通过只读探查解决事实性问题；
- 当偏好、取舍或高影响不确定性无法从仓库确认时，不得自行假设或绕过，必须主动提问。
- 需要提问时，优先使用当前宿主或环境提供的内置提问工具；不适用或不可用时，直接在回复中提问并暂停后续操作。
- 当遇到阻塞性问题时，主动停止并说明原因和需要的帮助。

## 代码与工具约定

- 保持现有 TypeScript 风格：ESM / NodeNext、严格类型、相对导入使用 `.js` 后缀、避免不必要的 `any`。
- 新增工具时，默认在 `src/tools/` 新建单独文件，默认导出 `MCPTool`，并在 `src/tools/index.ts` 注册。
- 工具 schema 的 `description` 是给 AI 看的 prompt，应简洁说明能力边界、参数约束、常见误用和与其他工具的配合方式。
- 添加或调整工具后，同步维护 `docs/tools/` 中的工具文档；必要时更新 `docs/DEVELOPMENT.md` 的工具列表或开发说明。

## 文件与并发安全

- 文件类工具必须通过 `resolvePath()` 和 `validatePathAccess()` 校验路径在 `rootDir` 范围内。
- 任何写文件工具都必须使用 `withFileLock()` 包裹写入流程；只读工具不需要加锁。
- 文本处理遵守 `lineEnding` 配置：读取后可统一为 `\n` 处理，写回时恢复目标行尾策略。
- 读取或处理文件内容前应考虑二进制文件检测，避免把二进制内容当文本处理。
- 错误返回应设置 `isError: true`，并给出能帮助 AI 自我修正的原因和下一步建议。

## 注释与文档

- 注释在能提升维护性时添加；优先解释“为什么”而不是代码“做了什么”；避免出现类似“将值赋给变量”的无意义注释。
- 适合写注释的场景包括但不限于：MCP / Windows 行为限制、竞态或并发保护、路径安全、失败恢复、兼容性权衡、非显然分支和 workaround。
- 不要为了迎合写注释的要求而强行添加行尾或逐行解释式 inline 注释；若确有必要，优先使用模块、函数、类型或短块注释说明关键原因。
- 核心运行时组件、重要工具 handler、复杂算法或关键类型建议补充必要的 JSDoc 或说明文档。
- `TODO` / `FIXME` 必须写明原因和预期后续动作，禁止留下 `TODO: fix this` 这类占位内容。
- 新增专题文档仅在有明确维护价值时创建，默认放在 `docs/` 及其子目录下合适的位置。

## 验证方式

- TypeScript 编译：`npm run build`。
- 单个脚本测试：`npx tsx test/<file>.ts`。
- 在受限的 Windows / PowerShell 环境或类似的沙箱环境下执行 `npx tsx test/<file>.ts` 时，需要显式加 `powershell.exe -ExecutionPolicy Bypass -Command ...`（`require_escalated` 提权无法绕过 `ExecutionPolicy`），或者改用 `cmd /c npx tsx test/<file>.ts`。
- 避免运行会改写源码、文档或快照的格式化/生成命令，除非用户明确要求或当前任务必须如此。

## 工具调用指导

- 当一次性读取大量文件时，优先使用 `read_many_files` 工具的 `shallow_read` 功能，预防可能发生的截断问题。
- 优先并行调用工具。
- `custom-mcp` 的 MCP 工具在实现层面支持并行调用。
- 写操作、会改变项目状态的命令、可能争用同一文件或同一外部资源的操作，应确认范围和依赖关系后再决定是否并行。

## Git 使用规则

- 默认允许只读 Git 操作：`git status`、`git diff`、`git log`、`git blame`。
- 除非用户特殊要求，否则 Git 操作不得输出作者名或作者邮箱；使用 `git log` 时选择不含作者字段的格式，使用 `git blame` 时优先使用 `git blame -s`。
- 未经用户明确同意和授权，不要执行 `git add`、`git commit`、`git branch`、`git tag` 或其他会改变仓库状态的 Git 操作。
- 如果用户明确允许或要求创建提交：
  * **按需读取**：当下一步是进行提交时，阅读 [docs/commit-guidelines.md](docs/commit-guidelines.md) 并遵循其中对于“约定式提交”的指引；避免不必要的提前读取。
  * 提交修改：基于实际改动生成提交信息。
- 在沙箱或受限权限环境中创建提交时，必须通过当前环境的正式**提权**流程运行 `git commit`，因为提交需要写入 `.git/`（如 `.git/index.lock`）。
- 未经用户明确授权，不要执行历史改写或破坏性操作，包括但不限于 `git commit --amend`、`git rebase`、`git reset`、`git clean`、`git stash`、`git cherry-pick`。
- 未经用户明确授权，不要执行远端操作，包括但不限于 `git push`、`git pull`、`git fetch` 或 force-push。
- 会话开始时已有的提交历史是受保护基线，不得改写、压缩、删除或重排。

## sub-agent 的使用

- 仅当用户明确表示允许使用时主 Agent 才考虑创建 sub-agent。
- [docs/sub-agent-guidelines.md](docs/sub-agent-guidelines.md)
- **注意：`docs/sub-agent-guidelines.md` 的内容默认只允许主 Agent（Parent Thread）查看，任何未受到明确授权的 sub-agent 禁止查看。**
