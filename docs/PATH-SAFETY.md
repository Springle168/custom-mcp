# 路径安全维护说明

本文记录文件类工具共享的路径安全语义。目标是让新增或维护工具时只接入统一路径安全层，不在工具层重复判断路径形态、root 边界、glob 展开或 symlink 行为。

---

## 适用范围

文件类工具使用 allowed roots 沙箱：

- `rootDir` 是 primary root。
- `otherRootDirs` 是 additional roots，可选。
- primary root 和 additional roots 合称 allowed roots。
- 相对 path / glob 永远只基于 primary root 解析。
- additional roots 只能通过 drive-absolute path / glob 访问。
- 所有普通路径、glob static base 和 glob 展开结果都必须命中唯一 matched root。
- 读取和写入的 realpath / symlink 校验必须保持在同一个 matched root 内，不能落入其它 allowed root。
- Android 构建工具不使用 `otherRootDirs`；`android.workspaceRoot` 也不会自动加入 allowed roots。
- 服务日志目录 `logsDir` 不属于 allowed roots，即使配置在 workspace 外也不会扩大文件工具访问边界。

`src/utils/paths.ts` 负责路径分类、allowed-root lexical 匹配和 canonical root；`src/utils/file-access-policy.ts` 在其上组合 policy candidate、root-specific ignore/deny、realpath 检查和受控 glob 遍历。配置文件中的 path-like 字段先由 `src/config/path-policy.ts` 执行 typed path existing-directory 输入校验；策略文件由 `src/config/file-access-policy.ts` 严格读取并编译。Runtime snapshot 为 selected workspace 保存统一的 `FileAccessPolicyContext`。文件类工具只通过 `ToolRuntimeContext.fileAccessPolicyContext` 消费文件访问能力，不自行遍历 `otherRootDirs`、读取策略文件或组合 deny 顺序。

---

## root 配置校验

配置加载阶段分两层处理路径：

1. `parseGlobalConfig()` 只校验全局索引中所有 `configFile` 的本地绝对路径形态；选中 reference 后，`parseWorkspaceConfig()` 通过 `src/config/path-policy.ts` 校验 selected workspace 的 path-like 配置字段。该层负责 typed string whitespace、本地绝对路径形态、Windows drive-absolute 要求、UNC / namespace / drive-relative / rooted-without-drive / `~` 拒绝，以及 workspace directory 字段真实存在且为目录。
2. `buildRuntimeConfigSnapshot()` 对 selected workspace 的 `rootDir + otherRootDirs` 创建并校验 `PathSafetyContext`。该层只把文件工具 allowed roots 交给 path safety；`logsDir` 和 Android paths 只写入 snapshot runtime path，不进入 `PathSafetyContext`。

`PathSafetyContext` 的不变量：

1. allowed roots 只来自 selected workspace 的 `rootDir` 与 `otherRootDirs`；env override allowlist、`logsDir` 和 Android paths 不能扩大文件访问边界。
2. 每个 root 必须真实存在且为目录。
3. root 本身可以是 symlink / junction。
4. 所有 allowed roots 在 lexical normalized path 层不得重复或互相嵌套。
5. 所有 allowed roots 在 realpath 层也不得重复或互相嵌套。

这些集合安全不变量由 `createValidatedPathSafetyContext()` 负责，并由 runtime snapshot builder 在启动期包装为结构化 `ConfigError`；selected workspace 的 `otherRootDirs` 错误会尽量定位到具体 `workspaces[i].otherRootDirs[j]`。`SafePath` / `SafeGlobPattern` 会携带 `matchedRoot`，供后续 read/write realpath 校验使用。

---

## 输入路径语义

### 支持的普通路径

| 类型 | 示例 | 语义 |
|-|-|-|
| relative | `src/index.ts`, `../maybe.ts` | 基于 primary root 解析；解析后必须仍在 primary root 内 |
| drive-absolute | `E:/Repo/src/index.ts`, `E:\\Repo\\src\\index.ts` | 按绝对路径解析；解析后必须位于唯一 allowed root 内 |

相对路径不能通过 `..` 逃出 primary root 后再命中 additional root。例如 primary root 为 `E:/Main`、additional root 为 `E:/Other` 时，`../Other/file.ts` 必须失败。

### 拒绝的普通路径

这些路径形态会在任何文件系统 I/O 前被拒绝：

| 类型 | 示例 | 原因 |
|-|-|-|
| drive-relative | `C:foo.txt` | Windows 会相对当前驱动工作目录解析，语义不稳定 |
| rooted without drive | `/foo.txt`, `\\foo.txt` | 无法明确表达目标工作区 |
| repeated rooted without drive | `///foo.txt`, `\\\\\\foo.txt` | 容易被误判为根路径、UNC 或特殊路径 |
| UNC | `//server/share/file.txt`, `\\\\server\\share\\file.txt` | 不支持网络共享路径 |
| namespace path | `\\\\?\\E:\\Repo\\file.txt`, `\\\\.\\C:\\path` | 可能绕过普通路径规范化规则 |

---

## 普通路径流程

普通文件路径必须按以下顺序处理：

1. 校验输入非空。
2. 分类输入路径形态，拒绝不支持形态。
3. relative 路径基于 primary root 解析；drive-absolute 路径按绝对路径解析。
4. 匹配唯一 allowed root：relative 只允许 matched root 为 primary root；drive-absolute 可匹配 primary 或 additional root。
5. 返回 `SafePath`，工具层使用 `SafePath.resolvedPath` 进行后续 I/O。

第 4 步之前禁止执行文件系统 I/O，包括 `fs.stat()`、`fs.lstat()`、`fs.realpath()`、`fs.readFile()`、`fs.writeFile()` 和 `glob()`。

---

## glob 流程

`read` 的字符串 `include` 项和 `discover_guidelines` 的 `include` 项可以是字面路径或 glob；`read` 的 object 请求始终按 literal 文件处理。字符串 selector 的处理顺序是：

1. 先尝试作为字面路径进入普通路径安全流程。
2. 已存在且是文件的字面路径按文件处理。
3. 若字面路径不存在或不是文件，且输入包含 glob 语法，再按 glob 处理。
4. glob 处理先计算 static base；static base 必须命中唯一 matched root，并通过 lexical/预计 real deny。
5. glob adapter 使用 matched root 作为 `cwd`，在每次 `readdir` 前执行目录 lexical/real deny；默认不跟随遍历中遇到的目录 symlink / junction。
6. 展开后的每个结果再次进入 lexical + realpath deny 校验，并且必须仍位于同一个 matched root 内。

支持的 glob 来源包括：

| 类型 | 示例 | 语义 |
|-|-|-|
| relative glob | `src/**/*.ts` | 基于 primary root 展开 |
| drive-absolute glob | `E:/Other/src/**/*.ts` | static base 必须命中唯一 allowed root；展开 `cwd` 为 matched root |
| slash-leading glob | `/**/Foo.kt` | 兼容行为，仅含 glob 元字符时按 relative glob 处理 |

普通 `/foo/bar.ts` 不含 glob 元字符，会按 rooted without drive 拒绝。

### glob parent traversal

glob static base 通过后，glob segment 中仍不能包含会在展开后形成 `..` 路径段的分支，例如：

- `{..,src}/**/*.ts`
- `.{a,b,.}/**/*.ts`
- `@(../src|src)/**/*.ts`

这类模式必须在调用 `glob()` 前拒绝，避免 glob 枚举 matched root 外部目录。

### 字面文件名中的 glob 字符

真实文件名可以包含 glob 元字符，例如：

- `special/file[test].ts`
- `special/file{brace}.ts`
- `special/file{a,b}.ts`

工具会先在 lexical 安全校验通过后按字面路径探测；只有字面文件不存在或不是文件时，才进入 glob 展开。

### ignore / exclude 语义

`read` 和 `discover_guidelines` 的软过滤只作用于 glob 自动发现结果：

| 输入类型 | 发现过滤 |
|-|-|
| relative literal | ignore：否；exclude：否 |
| drive-absolute literal | ignore：否；exclude：否 |
| `read` literal object | ignore：否；exclude：否 |
| relative glob | ignore：由 `use_ignore_files` 控制；exclude：是 |
| slash-leading glob | ignore：由 `use_ignore_files` 控制；exclude：是 |
| drive-absolute glob | ignore：由 `use_ignore_files` 控制；exclude：是 |

`ignoreFiles` 使用 Gitignore 语义并与 matched root 关联；`exclude` 使用 `glob` 包的 glob pattern 语义。两者只过滤通过访问校验的自动候选，不抹去已产生的非 deny 选择失败。选择层按输入顺序保留候选与失败，每条 glob 内按显示路径排序，并保留 `includeIndex`；去重和 `read` 的 object 覆盖由对应工具负责。没有硬编码默认 ignore。

### deny 语义

Deny 同时查询 lexical candidate 与 realpath candidate，并在实际类型确认后按文件或目录形式重查。Lexical deny 命中时不对目标执行 `stat`、`realpath`、内容读取或文件锁。写入不存在目标时，共享层将最近存在祖先的 realpath 与剩余 lexical 路径组合为预计 real target，再执行 deny。

Policy candidate 相对于 matched root 生成：文件形如 `a/b.txt`，目录形如 `a/`；分隔符统一为 `/`。Root 自身不生成 candidate，但仍校验 lexical/real root identity。

---

## display path 语义

返回中的显示路径由路径安全层统一决定：

| 输入来源 | matched root | display |
|-|-|-|
| relative path | primary root | 相对 primary root |
| relative glob | primary root | 相对 primary root |
| slash-leading glob | primary root | 相对 primary root |
| drive-absolute path | primary 或 additional root | 绝对路径 |
| drive-absolute glob | primary 或 additional root | 绝对路径 |

additional root 必须通过绝对路径访问，因此 additional root 的结果也显示绝对路径，避免调用方误以为可以用相对路径再次访问。

### 文件系统错误表达

文件访问、glob 展开和文件工具通过 `src/utils/file-system-errors.ts` 将文件系统异常转换为受控的公开原因。已知 errno 对应不存在、权限不足、路径组件错误、资源繁忙或存储不足等类别，未知异常使用固定兜底。

调用层负责操作说明和显示路径，不直接拼接异常的 `message`、真实路径、系统调用或堆栈；未知 glob 展开异常也不回显原始异常文本。Deny、越界、符号链接拒绝和内容分类失败保留各自语义，不作为一般 I/O 错误处理。

错误转换只负责展示，不参与文件缺失或创建授权判断。原始底层异常不另行写入日志，工具结果和 RESULT 日志使用相同的受控原因。

---

## realpath 与 symlink

lexical 校验只能保证路径字符串位于 matched root 内，不能保证真实文件系统目标仍在 matched root 内。因此读取和写入还要执行 realpath 相关校验。

### 读取路径

读取已存在文件时：

1. 做 lexical 路径安全与文件 candidate deny，得到 `SafePath.matchedRoot`。
2. 对目标执行 `fs.realpath()` 并校验仍位于同一个 real root。
3. 确认实际类型，按实际类型重新查询 lexical/real deny。
4. 再执行工具自身的文件类型、大小、完整字节读取及内容分类准入；共享[分类器](tools/read.md#内容分类规则)不自行打开路径。

如果目标不存在，按工具语义返回不存在，不需要读取真实路径。

关键限制：primary root 内的 symlink 不能通过相对路径访问 additional root；additional root 内的 symlink 也不能访问 primary root 或其它 additional root。realpath 后落入其它 allowed root 仍然必须失败。

### 写入路径

`write_file` 和 `replace_text` 共享写入安全策略：

1. 做 lexical 路径安全与文件 candidate deny；命中时在取得文件锁前失败。
2. 锁内查找最近存在祖先并计算预计 real target，执行 same-root 与 deny。
3. 目标存在时先按实际类型查询 lexical/real deny，再处理 symbolic link、目录或文件类型错误。
4. 创建缺失父目录后重新执行 realpath/root 与 deny。
5. 正式写入前再次执行写入安全与 deny。
6. 写入流程使用 `withFileLock()` 串行化同一路径的进程内写入。

---

## 工具接入要求

新增或维护文件类工具时：

- 从 `ToolRuntimeContext.fileAccessPolicyContext` 获取统一上下文，不要在工具层自行读取或遍历 roots、策略文件或 matcher。
- 普通路径使用 `resolveFileAccessPath()`，读取使用 `validateFileAccessReadTarget()`。
- 写入使用 `validateFileAccessWriteTarget()`，创建父目录后、正式写入前再次调用。
- glob 使用 `expandFileAccessGlob()`，不得退化为完整遍历后过滤 deny。
- 文件写入必须使用 `withFileLock()`。
- 所有文件系统 I/O 必须发生在 lexical path safety 之后。

单 root wrapper（如 `resolveSafePath(input, rootDir)`）仍保留用于兼容和窄范围测试；新增文件类工具默认应使用 context API。

---

## 测试入口

路径安全核心回归位于 `test/path-safety/`，文件访问策略横向回归位于 `test/file-access-policy/`，配置编译与 snapshot 集成位于 `test/config/`。这些测试覆盖：

- 配置层 allowed roots 绝对路径、存在性、目录类型、lexical 重复/嵌套和 realpath 重复/嵌套校验。
- 不支持路径形态的拒绝。
- root 字符串前缀相似目录拒绝。
- relative path / glob 只能访问 primary root。
- drive-absolute path / glob 可访问 primary 或 additional root。
- drive-absolute glob、slash-leading glob、glob static base 越界。
- brace / extglob parent traversal 拦截。
- 含 glob 元字符的字面文件名。
- literal 绕过 ignore/exclude、glob ignore 开关、deny mixed-result 隐私。
- primary / additional root 之间的 symlink realpath 越界拒绝。
- 写入目标 symlink 与写入父目录 symlink 相关行为。
