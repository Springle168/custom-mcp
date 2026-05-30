# 测试开发说明

本文记录 `custom-mcp` 的测试目录、脚本测试约定和常用验证命令。

---

## 测试目录

```text
custom-mcp/test/
├── android-build/           # Android 构建相关测试
├── replace-text/            # replace_text 相关测试
├── fixtures/                # 测试数据文件
│   └── read-many-files/
│       ├── setup.ts         # fixtures 生成脚本
│       ├── src/             # Kotlin 测试文件
│       ├── docs/            # Markdown 测试文件
│       ├── special-names/   # 特殊文件名测试
│       ├── binary/          # 二进制文件测试
│       ├── node_modules/    # 默认排除测试
│       └── build/           # 默认排除测试
├── logs/                    # 测试日志输出目录
├── inspect-tools.ts         # 输出 tools/list 结构
├── test-ask-user.ts         # ask_user 工具测试
├── test-config.ts           # 通用配置加载测试
├── test-logger.ts           # 日志系统测试
├── test-read-file.ts        # read_file 工具测试
├── test-replace-text.ts     # replace_text 工具测试
├── test-utils.ts            # 脚本测试公共断言与 runner
├── test-write-file.ts       # write_file 工具测试
└── test-read-many-files.ts  # read_many_files 工具测试
```

---

## 脚本测试

测试脚本默认保持独立运行，当前不依赖 `npm test` 或第三方测试框架。新增或调整普通脚本测试时，优先复用 `test/test-utils.ts`：

- 使用 `assert()`、`assertEqual()`、`assertIncludes()`、`assertNotIncludes()` 统一断言错误格式。
- 使用 `getResultText()` 提取 MCP 工具调用结果中的首段文本，避免各测试重复定义结果结构。
- 使用 `runTestSuite()` 注册测试用例；默认输出测试套件标题、失败用例和最终 `Results: ...` 汇总，成功用例及其 `console.*` 输出会保持静默。需要旧的逐用例 `Test: ...` / `✓ Passed` 输出时，在测试命令末尾追加 `--verbose`。
- 需要准备或清理 fixture 时，通过 `beforeAll` / `afterAll` 挂到 `runTestSuite()`；`afterAll` 会在测试失败后继续执行。
- `test/test-ask-user.ts`、`test/inspect-tools.ts`、`test/test-logger.ts` 属于交互、检查或日志演示脚本，可按自身输出需求保留独立结构。

---

## 常用验证命令

```bash
# TypeScript 编译
npm run build

# 单个脚本测试
npx tsx test/test-read-file.ts

# 查看 tools/list 结构
npx tsx test/inspect-tools.ts
```

---

## Android 构建相关测试

Android 构建相关测试集中在 `test/android-build/`。其中 timeout / launcher 测试依赖 Windows 进程树和 `gradlew.bat` 启动行为，在沙箱或受限权限环境中的 AI Agent 需要提权才能跑测试验证。

Android 构建工具本身的行为文档见 [docs/tools/android-build.md](tools/android-build.md)。

---

## 测试日志

运行 `test/test-logger.ts` 可以测试日志系统的颜色输出效果：

```bash
npx tsx test/test-logger.ts
```

默认会跳过超大 JSON 演示，避免 Agent 或自动化运行时输出大量噪音；需要验证 50KB 阈值下的大输出降级行为时，追加 `--verbose`：

```bash
npx tsx test/test-logger.ts --verbose
```

测试生成的日志文件保存在 `test/logs/` 目录下，不会与生产日志混淆。日志系统设计见 [docs/LOGGING.md](LOGGING.md)。
