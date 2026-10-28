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

每个脚本默认限时 120 秒，期限覆盖从 spawn 到 `close` 的完整生命周期，包括根进程退出后仍被后代持有的输出 pipe。单一 CLI 参数 `--timeout-ms <正整数>` 对本次全部选中脚本生效，范围为 `1` 至 `2147483647` 毫秒，不能用 `0` 禁用，也没有环境变量、配置文件或主题级覆盖。超时始终计为失败，迟到的退出码 `0` 不能改写结果；compact 与 verbose 均报告脚本路径、期限和耗时。

超时清理最多使用独立的 5 秒总预算。Windows 对本次 spawn 且尚未观察到退出的根 PID 执行 `taskkill /pid <pid> /t /f`，隐藏 helper 窗口；helper 尝试最多 3 秒，终止 helper 后最多再等待 1 秒，所有等待都受同一个总预算约束。只有 helper 成功且子进程 `close` 均已确认，才允许继续执行后续脚本。若根进程已退出，runner 不会对可能复用的旧 PID 调用 `taskkill`。

普通失败和已确认清理的超时允许继续执行；清理失败、超期或无法确认停止时，runner 释放本地 stdio 与进程引用并立即停止调度，明确报告停止原因和未运行路径，汇总只统计实际执行的脚本。本地句柄释放不等于 OS 进程已死亡。非 Windows 仅尽力终止直接子进程，不建立 Unix 进程组；runner 不保证终止已经脱离的后代，也不提供强 OS 隔离，不删除共享 fixture。

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

manual 和 privileged 脚本使用 `node --import tsx <script>` 显式执行。人工日志验证见[日志](LOGGING.md#测试与人工验证)，Windows 进程树终止验证见[Android 工具](tools/android-build.md#验证重点)。

runner 主题的普通测试使用真实挂住但没有后代的 fixture、直接子进程终止和 fake helper，覆盖期限、输出、迟到事件与有界清理失败；测试 watchdog 和 fixture 自身退出期限独立于被测机制。真实 Windows 进程树终止使用 `node --import tsx test/runner/timeout.privileged.ts` 显式验证，需要先取得进程树终止权限，不属于 `npm test` 的自动化发现范围。

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
