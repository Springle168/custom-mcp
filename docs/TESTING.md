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
├── ask-user/                   # ask_user 答案格式测试与人工交互脚本，见 docs/tools/ask-user.md
├── config/                     # 全局配置、workspace selection、env override 和 snapshot 测试，见 docs/CONFIG.md
├── fixtures/                   # 测试数据与运行期生成的 fixture 目录
├── helpers/                    # 测试辅助函数，如 runtime-config.ts
├── logger/                     # 日志系统演示/测试，见 docs/LOGGING.md
├── logs/                       # 测试日志输出目录
├── path-safety/                # 路径安全横向回归，见 docs/PATH-SAFETY.md
├── read-file/                  # read_file 工具测试，见 docs/tools/read-file.md
├── read-many-files/            # read_many_files 工具测试，见 docs/tools/read-many-files.md
├── replace-text/               # replace_text 工具测试，见 docs/tools/replace-text.md
├── runtime/                    # ConfigStore、request context、request header policy 和 tool-call handler 测试，见 docs/CONFIG.md
├── tools/                      # tools/list 检查脚本和 definition shape 回归，见 docs/TOOLS.md
├── write-file/                 # write_file 工具测试，见 docs/tools/write-file.md
└── test-utils.ts               # 脚本测试公共断言与 runner
```

---

## 脚本测试

测试脚本默认保持独立运行，当前不依赖 `npm test` 或第三方测试框架。新增或调整普通脚本测试时，优先复用 `test/test-utils.ts`：

- 使用 `assert()`、`assertEqual()`、`assertIncludes()`、`assertNotIncludes()` 统一断言错误格式。
- 使用 `getResultText()` 提取 MCP 工具调用结果中的首段文本，避免各测试重复定义结果结构。
- 使用 `runTestSuite()` 注册测试用例；默认输出测试套件标题、失败用例和最终 `Results: ...` 汇总，并静默测试用例内的 `console.*` 输出。需要查看逐用例 `Test: ...` / `✓ Passed` 和测试内 `console.*` 输出时，在测试命令末尾追加 `--verbose`。
- 需要准备或清理 fixture 时，通过 `beforeAll` / `afterAll` 挂到 `runTestSuite()`；`afterAll` 会在测试失败后继续执行。
- `test/ask-user/ask-user.manual.ts`、`test/tools/inspect-tools.ts`、`test/logger/logger.test.ts` 属于交互、检查或日志演示脚本，可按自身输出需求保留独立结构。

---

## 常用验证命令

```bash
# TypeScript 编译
npm run build

# 脚本测试示例
node --import tsx test/read-file/read-file.test.ts
```

单个脚本测试直接用 `node --import tsx` 运行对应 `test/<topic>/*.ts` 文件。各主题的脚本位置见上方测试目录索引；更细的测试覆盖范围见对应专题文档或单工具文档。

Request header rules 与 `structuredContentDup` feature / `structuredContent` wrapper focused tests：

```bash
node --import tsx test/config/request-header-rules.test.ts
node --import tsx test/config/runtime-snapshot.test.ts
node --import tsx test/runtime/request-header-view.test.ts
node --import tsx test/runtime/request-context.test.ts
node --import tsx test/runtime/request-header-policy.test.ts
node --import tsx test/runtime/tool-result-adapter.test.ts
node --import tsx test/runtime/tool-call-handler.test.ts
node --import tsx test/runtime/mcp-post-request-context.test.ts
node --import tsx test/logger/request-header-rules-logging.test.ts
node --import tsx test/runtime/request-context-concurrency.test.ts
node --import tsx test/tools/tool-definitions.test.ts
```

这些脚本覆盖配置解析、snapshot deep-freeze、strict header view、request context、policy、统一出口 result adapter、POST `/mcp` request context seam、`Rules:` 响应日志格式与隐私边界、request context 并发隔离和 `tools/list` 不暴露 `outputSchema`。

`ask_user` 答案规范化与结果格式化测试：

```bash
node --import tsx test/ask-user/ask-user-result.test.ts
```

---

## Android 构建相关测试

Android 构建相关测试集中在 `test/android-build/`。其中 timeout / launcher 测试依赖 Windows 进程树和 `gradlew.bat` 启动行为，在沙箱或受限权限环境中的 AI Agent 需要**提权**才能跑测试验证。

Android 构建工具本身的行为文档见 [docs/tools/android-build.md](tools/android-build.md)。

---

## 测试日志

日志测试说明见 [docs/LOGGING.md](LOGGING.md)。
