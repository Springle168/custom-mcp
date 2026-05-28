# 路径安全维护说明

本文记录文件类工具共享的路径安全语义。目标是让新增或维护工具时只接入统一路径安全层，不在工具层重复判断路径形态、root 边界、glob 展开或 symlink 行为。

---

## 适用范围

当前项目使用单一 `rootDir` 沙箱：

- `rootDir` 是唯一允许访问的文件边界。
- 相对路径基于 `rootDir` 解析。
- drive-absolute 路径必须最终位于 `rootDir` 内。
- glob 模式在展开前和展开后都必须保持在 `rootDir` 内。
- 文件类工具的路径入口统一由 `src/utils/paths.ts` 处理。

---

## 输入路径语义

### 支持的普通路径

| 类型 | 示例 | 语义 |
|-|-|-|
| relative | `src/index.ts`, `../maybe.ts` | 基于 `rootDir` 解析，解析后必须仍在 `rootDir` 内 |
| drive-absolute | `E:/Repo/src/index.ts`, `E:\Repo\src\index.ts` | 按绝对路径解析，解析后必须在 `rootDir` 内 |

### 拒绝的普通路径

这些路径形态会在任何文件系统 I/O 前被拒绝：

| 类型 | 示例 | 原因 |
|-|-|-|
| drive-relative | `C:foo.txt` | Windows 会相对当前驱动工作目录解析，语义不稳定 |
| rooted without drive | `/foo.txt`, `\foo.txt` | 无法明确表达工作区意图 |
| repeated rooted without drive | `///foo.txt`, `\\\foo.txt` | 容易被误判为根路径或特殊路径 |
| UNC | `//server/share/file.txt`, `\\server\share\file.txt` | 当前设计不支持网络共享路径 |
| namespace path | `\\?\E:\Repo\file.txt`, `\\.\C:\path` | 可能绕过普通路径规范化规则 |

---

## 普通路径流程

普通文件路径必须按以下顺序处理：

1. 校验输入非空。
2. 分类输入路径形态，拒绝不支持形态。
3. 将 relative 路径基于 `rootDir` 解析；drive-absolute 路径按绝对路径解析。
4. 做 lexical root 边界校验。
5. 返回 `SafePath`，工具层使用 `SafePath.resolvedPath` 进行 I/O。

第 4 步之前禁止执行文件系统 I/O，包括 `fs.stat()`、`fs.lstat()`、`fs.realpath()`、`fs.readFile()`、`fs.writeFile()`、`isBinaryFile()` 和 `glob()`。

---

## glob 流程

`read_many_files` 的 include 项既可能是字面路径，也可能是 glob。处理顺序是：

1. 先尝试作为字面路径进入普通路径安全流程。
2. 已存在且是文件的字面路径按文件处理。
3. 若字面路径不存在或不是文件，且输入包含 glob 语法，再按 glob 处理。
4. glob 处理先计算 static base；static base 必须位于 `rootDir` 内，否则不调用 `glob()`。
5. `glob()` 展开后的每个结果再次进入 lexical + realpath 校验。

支持的 glob 来源包括：

| 类型 | 示例 | 语义 |
|-|-|-|
| relative glob | `src/**/*.ts` | 基于 `rootDir` 展开 |
| drive-absolute glob | `E:/Repo/src/**/*.ts` | static base 和结果都必须在 `rootDir` 内 |
| slash-leading glob | `/**/Foo.kt` | 兼容行为，仅含 glob 元字符时按 relative glob 处理 |

普通 `/foo/bar.ts` 不含 glob 元字符，会按 rooted without drive 拒绝。

### glob parent traversal

glob static base 通过后，glob segment 中仍不能包含会在展开后形成 `..` 路径段的分支，例如：

- `{..,src}/**/*.ts`
- `.{a,b,.}/**/*.ts`
- `@(../src|src)/**/*.ts`

这类模式必须在调用 `glob()` 前拒绝，避免 glob 枚举 `rootDir` 外部目录。

### 字面文件名中的 glob 字符

真实文件名可以包含 glob 元字符，例如：

- `special/file[test].ts`
- `special/file{brace}.ts`
- `special/file{a,b}.ts`

工具会先在 lexical 安全校验通过后按字面路径探测；只有字面文件不存在或不是文件时，才进入 glob 展开。

### exclude 语义

`read_many_files` 中 drive-absolute 字面路径不受 exclude 过滤，因为调用方显式指定了绝对文件。relative 字面路径仍受默认和用户提供的 exclude 过滤。

relative 字面路径的 exclude 检查使用 `glob.Ignore`，要求：

- 字面路径本身不能被重新解释为 glob。
- exclude pattern 必须保留 brace / extglob 语义，例如 `src/*.{ts,tsx}`、`src/@(Foo).ts`。
- Windows 下匹配应保持大小写不敏感，与 `glob(..., { ignore })` 行为一致。

---

## realpath 与 symlink

lexical 校验只能保证路径字符串位于 `rootDir` 内，不能保证真实文件系统目标仍在 `rootDir` 内。因此读取和写入还要执行 realpath 相关校验。

### 读取路径

读取已存在文件时：

1. 先做 lexical 路径安全校验。
2. 对目标执行 `fs.realpath()`。
3. 校验真实目标仍在 `rootDir` 内。
4. 再执行 `fs.stat()`、二进制检测和文本读取。

如果目标不存在，按工具语义返回不存在，不需要读取真实路径。

### 写入路径

`write_file` 和 `replace_text` 共享写入安全策略：

1. 先做 lexical 路径安全校验。
2. 查找目标父目录中最近的已存在祖先目录。
3. 对该祖先目录执行 `fs.realpath()` 并确认仍在 `rootDir` 内。
4. 如果目标文件已存在且是 symbolic link，拒绝写入。
5. 创建缺失父目录后、正式写入前再次执行写入安全校验。
6. 写入流程必须包裹在 `withFileLock()` 中。

---

## 工具接入要求

新增或维护文件类工具时：

- 普通路径使用 `resolveSafePath()`，不要在工具层自行调用 `path.isAbsolute()` 判断用户意图。
- 读取已存在文件前调用 `validateSafeReadTarget()`。
- 写入文件前调用 `validateSafeWriteTarget()`，创建父目录后、正式写入前再次调用。
- glob 输入使用 `resolveSafeGlobPattern()` 做展开前校验，展开结果使用 `resolveSafeGlobEntry()` 做逐项校验。
- 文件写入必须使用 `withFileLock()`。
- 所有文件系统 I/O 必须发生在 lexical path safety 之后。

---

## 测试入口

路径安全核心回归测试位于：

```bash
cmd /c npx tsx test/test-path-safety.ts
```

该测试覆盖：

- 不支持路径形态的拒绝。
- root 字符串前缀相似目录拒绝。
- drive-absolute glob、slash-leading glob、glob static base 越界。
- brace / extglob parent traversal 拦截。
- 含 glob 元字符的字面文件名。
- relative 字面路径的 exclude 语义。
- 读取 symlink escape 与写入 symlink 相关行为。

