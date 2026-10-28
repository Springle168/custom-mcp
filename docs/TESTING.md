# 测试开发说明

本文维护测试组织、脚本发现与执行规则，以及验证命令。测试主题和公共 helper 的布局见[项目结构](PROJECT-STRUCTURE.md#测试)；功能特有的验证目标与环境前提放在对应专题，不逐个维护测试文件索引。

## 组织与发现

- 普通自动化测试按维护主题放在 `test/<topic>/`，使用 `*.test.ts`。跨工具、跨层的不变量按共享主题归类。
- 公共断言与 suite runner 位于 `test/test-utils.ts`；runtime 与 invocation 构造等 helper 位于 `test/helpers/`。
- 需要默认受限环境之外权限的脚本使用 `*.privileged.ts`；人工观察或交互脚本使用 `*.manual.ts`。它们不属于默认自动化测试集，权限和人工步骤由所属专题说明。
- 测试生成物集中放在 `test/fixtures/` 或 `test/logs/`，不混入源码、开发文档或生产日志目录。测试专属静态 fixture 可与主题共置。

`npm test` 通过 `test/run-tests.ts` 发现全部 `test/**/*.test.ts`；privileged、manual、helper、fixture setup 与 inspect 脚本不匹配自动化发现规则。

## Suite 与脚本隔离

普通测试脚本复用 `test/test-utils.ts` 的 `assert()`、`assertEqual()`、`assertIncludes()`、`assertNotIncludes()`、`getResultText()` 和 `runTestSuite()`。`getResultText()` 用于断言首个文本块，不替代图文或多块结果的完整结构断言。

`runTestSuite()` 默认输出 suite 标题、失败用例与 `Results: ...` 汇总，静默用例内部 `console.*`。通过 `beforeAll` / `afterAll` 管理 fixture；`afterAll` 在测试失败后仍执行。

runner 使用独立 Node 子进程逐脚本串行执行，避免共享 fixture 的跨脚本竞态。成功脚本的内部输出折叠，按主题汇总数量与耗时；失败脚本展开捕获输出，最终返回非零退出码。每个脚本最多捕获 256 KB 输出，超出部分显示截断提示。

`--verbose` 传给被选中的脚本，显示逐用例结果与测试内部输出，并由 runner 实时透传。

### 脚本期限与清理

每个脚本默认限时 120 秒，覆盖初始化、测试和脚本自身清理。`--timeout-ms <正整数>` 设置本次全部选中脚本的期限，单位为毫秒。

普通失败会继续执行；超时计为失败，并另行尝试有界进程清理。确认清理后继续，否则停止调度并报告未运行脚本，避免残留进程干扰后续测试。

强制终止可能跳过 `afterAll`；runner 不负责清理共享 fixture，也不保证终止已脱离的后代。

## 选择与显式执行

selector 接受主题名、仓库相对路径或文件名，路径分隔符可以是 `/` 或 `\\`。多个 selector 使用 OR 语义；任一 selector 无匹配时，runner 在执行前报错。

```bash
npm test -- <topic>
npm test -- <topic-a> <topic-b>
npm test -- test/<topic>/<name>.test.ts
npm test -- <name>.test.ts
npm test -- <topic> --verbose
npm test -- <topic> --timeout-ms 180000
```

manual 和 privileged 脚本使用 `node --import tsx <script>` 显式执行。

专项验证入口：

- 日志人工验证：执行方式与观察重点见[日志](LOGGING.md#测试与人工验证)。
- Android 进程清理验证：执行方式与权限前提见[Android 工具](tools/android-build.md#验证重点)。
- Runner 进程树清理验证：修改 runner 的 Windows 进程树清理逻辑时，使用 `node --import tsx test/runner/timeout.privileged.ts` 显式验证；执行前需取得进程树终止权限。

## 验证命令与覆盖边界

| 命令 | 验证范围 |
|-|-|
| `npm exec -- prettier --write <文件路径...>` | 格式化指定代码文件 |
| `npm run format:check` | 检查预设代码与配置范围，不写入文件 |
| `npm run lint` | 静态规则检查，不自动修复 |
| `npm run build` | 生产源码编译，输出 `dist/` |
| `npm run typecheck:test` | 生产源码与测试代码的无输出类型检查 |
| `npm run check` | 顺序执行格式检查、lint、生产构建、测试类型检查 |
| `npm test` | 串行执行默认自动化测试集 |

`npm run format -- <文件路径...>` 只会追加参数，不能把脚本的预设范围缩小到指定文件。修改代码后，先格式化本次代码文件，再进行格式检查与相应验证。格式脚本的预设范围不包含 Markdown。

生产构建使用 `tsconfig.json`，不检查测试代码。测试类型检查使用 `tsconfig.test.json`，检查源码与测试并通过 `noEmit` 禁止生成文件。构建与类型检查使用 TypeScript 7；ESLint 通过 `typescript` 安装别名使用 TypeScript 6 API，其类型分析不能替代 TypeScript 7 的类型检查。

`npm test` 不执行生产构建或静态类型检查；`tsx` 负责转译执行。因此修改测试后，应分别运行相关脚本与 `npm run typecheck:test`，运行成功和类型检查通过不能相互替代。
