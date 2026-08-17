# 测试开发说明

本文记录 `custom-mcp` 的测试组织规则、脚本测试约定和常用验证命令。具体功能的测试结构优先在对应专题文档或单工具文档中展开，本文只保留跨主题约定和索引。

---

## 测试组织规则

测试脚本按维护主题归类：

- 有专题文档或单工具文档承接的测试，放在对应 `test/<topic>/` 目录，并在该专题文档中展开结构和命令。
- 跨工具或跨层的不变量测试，放在对应横向目录，例如 `test/path-safety/`。
- 测试公共断言、runner 和 runtime 构造 helper 保留在 `test/test-utils.ts` 与 `test/helpers/`。
- 检查、演示或人工交互脚本可放在专门目录中，并用文件名标明用途，例如 `*.manual.ts`。
- 测试生成物集中放在 `test/fixtures/` 或 `test/logs/`，不要混入源码、文档或生产日志目录。

---

## 测试目录索引

```text
custom-mcp/test/
├── android-build/              # Android 构建工具测试，见 docs/tools/android-build.md
├── ask-user/                   # ask_user 答案、HTTP 路由测试与人工交互脚本，见 docs/tools/ask-user.md
├── config/                     # 全局配置、workspace selection、env override 和 snapshot 测试，见 docs/CONFIG.md
├── fixtures/                   # 测试数据与运行期生成的 fixture 目录
├── helpers/                    # 测试辅助函数，如 runtime-config.ts
├── logger/                     # 日志系统演示/测试，见 docs/LOGGING.md
├── logs/                       # 测试日志输出目录
├── path-safety/                # 路径安全横向回归，见 docs/PATH-SAFETY.md
├── read-file/                  # read_file 工具测试，见 docs/tools/read-file.md
├── read-many-files/            # read_many_files 工具测试，见 docs/tools/read-many-files.md
├── replace-text/               # replace_text 工具测试，见 docs/tools/replace-text.md
├── runner/                     # 统一测试 runner 的发现、筛选与失败继续回归
├── runtime/                    # ConfigStore、request context、request header policy 和 tool-call handler 测试，见 docs/CONFIG.md
├── tools/                      # tools/list 检查脚本和 definition shape 回归，见 docs/TOOLS.md
├── write-file/                 # write_file 工具测试，见 docs/tools/write-file.md
├── run-tests.ts                # 自动化脚本发现、串行调度、计时和汇总入口
└── test-utils.ts               # 脚本测试公共断言与 suite runner
```

---

## 脚本测试

普通测试脚本保持独立运行并复用 `test/test-utils.ts`：

- 使用 `assert()`、`assertEqual()`、`assertIncludes()`、`assertNotIncludes()` 统一断言错误格式。
- 使用 `getResultText()` 提取 MCP 工具调用结果中的首段文本，避免各测试重复定义结果结构。
- 使用 `runTestSuite()` 注册测试用例；默认输出测试套件标题、失败用例和最终 `Results: ...` 汇总，并静默测试用例内的 `console.*` 输出。需要查看逐用例 `Test: ...` / `✓ Passed` 和测试内 `console.*` 输出时，在测试命令末尾追加 `--verbose`。
- 需要准备或清理 fixture 时，通过 `beforeAll` / `afterAll` 挂到 `runTestSuite()`；`afterAll` 会在测试失败后继续执行。

`test/run-tests.ts` 负责脚本级发现、筛选、串行调度、计时和汇总。默认自动化测试集包括 `test/**/*.test.ts` 与 Android 构建目录下历史命名的 `test-*.ts`，但排除日志演示脚本 `test/logger/logger.test.ts`。manual、helper、fixture setup 和 inspect 脚本不符合自动化发现规则，不由 `npm test` 执行。

测试脚本使用独立 Node 子进程逐个串行运行，避免共享 fixture 的跨脚本竞态。默认模式捕获子脚本输出：成功脚本的内部输出被折叠，runner 按主题汇总脚本数量与耗时；失败脚本的捕获输出会自动展开，runner 随后继续执行剩余脚本，最终汇总所有失败并返回非零退出码。单个脚本的捕获输出限制为 256 KB，超过部分以截断提示代替，避免异常日志无限占用内存。

`--verbose` 会传递给每个被选中的测试脚本，并将子脚本输出实时透传到终端，适合查看逐用例结果和测试内部的 `console.*` 输出。

---

## 常用验证命令

```bash
# 编译生产源码 src/**/*.ts 并生成 dist
npm run build

# 对 src/**/*.ts 与 test/**/*.ts 执行类型检查，不生成文件
npm run typecheck:test

# 依次执行生产构建和测试类型检查
npm run check

# 串行运行默认自动化测试集
npm test

# 按主题筛选；多个 selector 使用 OR 语义
npm test -- config
npm test -- config runtime

# 按仓库相对路径或文件名筛选
npm test -- test/config/value-policy.test.ts
npm test -- value-policy.test.ts

# 查看逐用例与测试内部输出
npm test -- config --verbose
```

`npm run build` 使用 `tsconfig.json`，只覆盖生产源码。`npm run typecheck:test` 使用 `tsconfig.test.json`，在复用生产编译选项的同时检查生产源码与测试代码，并通过 `noEmit` 禁止生成文件。

`npm test` 不执行生产构建或静态类型检查。`tsx` 负责转译并执行测试脚本，不执行与 `tsc` 等价的完整类型检查；脚本运行成功不表示测试代码通过静态类型检查。调整测试后，应分别运行对应脚本的 `npm test -- <selector>` 与 `npm run typecheck:test`。各主题的脚本位置见上方测试目录索引；更细的测试覆盖范围见对应专题文档或单工具文档。

selector 支持主题名、仓库相对路径和文件名，接受 `/` 或 `\\` 路径分隔符。多个 selector 按 OR 组合；任一 selector 没有匹配自动化脚本时，runner 会在执行前报错，避免静默空跑。

Request header rules 与 `structuredContentDup` feature / `structuredContent` wrapper focused tests：

```bash
npm test -- test/config/request-header-rules.test.ts
npm test -- test/config/runtime-snapshot.test.ts
npm test -- test/runtime/request-header-view.test.ts
npm test -- test/runtime/request-context.test.ts
npm test -- test/runtime/request-header-policy.test.ts
npm test -- test/runtime/tool-result-adapter.test.ts
npm test -- test/runtime/tool-call-handler.test.ts
npm test -- test/runtime/mcp-post-request-context.test.ts
npm test -- test/logger/request-header-rules-logging.test.ts
npm test -- test/runtime/request-context-concurrency.test.ts
npm test -- test/tools/tool-definitions.test.ts
```

这些脚本覆盖配置解析、snapshot deep-freeze、strict header view、request context、policy、统一出口 result adapter、POST `/mcp` request context seam、`Rules:` 响应日志格式与隐私边界、request context 并发隔离和 `tools/list` 不暴露 `outputSchema`。

`ask_user` 答案规范化、结果格式化与 HTTP 路由测试：

```bash
npm test -- test/ask-user/ask-user-result.test.ts
npm test -- test/ask-user/ask-user-routes.test.ts
```

---

## Android 构建相关测试

Android 构建相关测试集中在 `test/android-build/`。其中 timeout / launcher 测试依赖 Windows 进程树和 `gradlew.bat` 启动行为，在沙箱或受限权限环境中的 AI Agent 需要**提权**才能跑测试验证。

Android 构建工具本身的行为文档见 [docs/tools/android-build.md](tools/android-build.md)。

---

## 测试日志

日志测试说明见 [docs/LOGGING.md](LOGGING.md)。
