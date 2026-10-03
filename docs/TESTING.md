# 测试开发说明

本文记录 `custom-mcp` 的测试组织规则、脚本测试约定和常用验证命令。具体功能的测试结构优先在对应专题文档或单工具文档中展开，本文只保留跨主题约定和索引。

---

## 测试组织规则

测试脚本按维护主题归类：

- 有专题文档或单工具文档承接的测试，放在对应 `test/<topic>/` 目录，并在该专题文档中展开测试边界和特有前置条件。
- 跨工具或跨层的不变量测试，放在对应横向目录，例如 `test/path-safety/`。
- 测试公共断言、runner 和 runtime 构造 helper 保留在 `test/test-utils.ts` 与 `test/helpers/`。
- 需要默认受限环境之外权限的自动化脚本使用 `*.privileged.ts` 后缀，由维护者在满足权限前提的环境中显式运行。
- 检查、演示或人工交互脚本可放在专门目录中，并用文件名标明用途，例如 `*.manual.ts`。
- 测试生成物集中放在 `test/fixtures/` 或 `test/logs/`，不要混入源码、文档或生产日志目录。

---

## 测试目录索引

```text
custom-mcp/test/
├── android-build/              # Android 构建工具测试，见 docs/tools/android-build.md
├── config/                     # 全局配置、workspace selection、env override 和 snapshot 测试，见 docs/CONFIG.md
├── fixtures/                   # 测试数据与运行期生成的 fixture 目录
├── helpers/                    # 测试辅助函数，如 runtime-config.ts
├── logger/                     # 日志自动化测试与人工视觉验证，见 docs/LOGGING.md
├── logs/                       # 测试日志输出目录
├── path-safety/                # 路径安全横向回归，见 docs/PATH-SAFETY.md
├── read-file/                  # read_file 工具测试，见 docs/tools/read-file.md
├── read-many-files/            # read_many_files 工具测试，见 docs/tools/read-many-files.md
├── replace-text/               # replace_text 工具测试，见 docs/tools/replace-text.md
├── runner/                     # 统一测试 runner 的发现、筛选与失败继续回归
├── runtime/                    # 应用启动/关闭、ConfigStore、request policy、tool-call handler 和 HTTP/MCP wiring 测试
├── tools/                      # custom definition loader、schema validator、catalog/exposure 和 tools/list shape 回归
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

`test/run-tests.ts` 负责脚本级发现、筛选、串行调度、计时和汇总。默认自动化测试集包括全部 `test/**/*.test.ts`；privileged、manual、helper、fixture setup 和 inspect 脚本不符合自动化发现规则，不由 `npm test` 执行。

测试脚本使用独立 Node 子进程逐个串行运行，避免共享 fixture 的跨脚本竞态。默认模式捕获子脚本输出：成功脚本的内部输出被折叠，runner 按主题汇总脚本数量与耗时；失败脚本的捕获输出会自动展开，runner 随后继续执行剩余脚本，最终汇总所有失败并返回非零退出码。单个脚本的捕获输出限制为 256 KB，超过部分以截断提示代替，避免异常日志无限占用内存。

`--verbose` 会传递给每个被选中的测试脚本，并将子脚本输出实时透传到终端，适合查看逐用例结果和测试内部的 `console.*` 输出。

`*.manual.ts` 脚本需要显式以 `node --import tsx <script>` 运行；脚本自身及其专题文档负责说明特有的前置条件和人工操作。

`*.privileged.ts` 脚本同样使用 `node --import tsx <script>` 显式运行；所需权限和具体命令由对应专题文档说明。

---

## 常用验证命令

```bash
# 检查预设范围的排版，不写入文件
npm run format:check

# 静态规则检查，不自动修复
npm run lint

# 编译生产源码 src/**/*.ts 并生成 dist
npm run build

# 对 src/**/*.ts 与 test/**/*.ts 执行类型检查，不生成文件
npm run typecheck:test

# 依次执行格式检查、静态规则检查、生产构建和测试类型检查
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

局部格式化使用 `npm exec -- prettier --write <文件路径...>`。`npm run format -- <文件路径...>` 会向脚本追加参数，不会将格式化范围缩小到指定文件。

构建与类型检查使用 TypeScript 7 的 `tsc`；ESLint 通过 `typescript` 安装别名加载 TypeScript 6 的 JavaScript API。两者职责独立：lint 的类型分析基于 TypeScript 6，不能替代 TypeScript 7 的类型检查。

`npm run build` 使用 `tsconfig.json`，只覆盖生产源码。`npm run typecheck:test` 使用 `tsconfig.test.json`，在复用生产编译选项的同时检查生产源码与测试代码，并通过 `noEmit` 禁止生成文件。

`npm test` 不执行生产构建或静态类型检查。`tsx` 负责转译并执行测试脚本，不执行与 `tsc` 等价的完整类型检查；脚本运行成功不表示测试代码通过静态类型检查。调整测试后，应分别运行对应脚本的 `npm test -- <selector>` 与 `npm run typecheck:test`。各主题的脚本位置见上方测试目录索引，更细的测试覆盖范围见对应专题文档或单工具文档。

selector 支持主题名、仓库相对路径和文件名，接受 `/` 或 `\\` 路径分隔符。多个 selector 按 OR 组合；任一 selector 没有匹配自动化脚本时，runner 会在执行前报错，避免静默空跑。
