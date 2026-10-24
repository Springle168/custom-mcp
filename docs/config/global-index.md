# 全局 workspace 索引

全局索引把稳定的 workspace id 映射到独立 workspace 配置文件。它不承载 HTTP、文件访问、工具暴露或 Android 等运行参数；这些参数由 selected workspace 配置文件定义，见 [workspace 配置](workspace-config.md)。两层模型和完整加载管线见 [配置概览](../CONFIG.md)。

---

## 位置与示例

服务固定读取：

```text
~/.custom-mcp/config.json
```

Windows 上通常展开为 `%USERPROFILE%\.custom-mcp\config.json`。完整模板见 [config.example.json](../../examples/config.example.json)：

使用模板时替换其中的本地绝对路径和值；运行时文件名保持 `config.json`，不使用示例文件名。

---

## Schema

顶层只允许 `version` 与 `workspaces`：

| 字段 | 类型 | 必填 | 约束 |
|-|-|-|-|
| `version` | JSON number | 是 | 必须为 `2`。 |
| `workspaces` | object[] | 是 | 必须是非空数组。 |

每个 `workspaces[]` reference 只允许 `id` 与 `configFile`：

| 字段 | 类型 | 必填 | 约束 |
|-|-|-|-|
| `id` | string | 是 | 长度 `1..64`；以小写字母或数字开头；只允许小写字母、数字、`-`、`_`；在全局索引中唯一。 |
| `configFile` | string | 是 | 无首尾 whitespace 的本地绝对路径。 |

顶层和 reference 的未知字段都会导致配置失败。

### `configFile` 路径边界

`configFile` 使用 lexical 本地路径策略：

- 不接受相对路径、`~` 展开、UNC、namespace path、drive-relative path 或 rooted-without-drive path。
- Windows 上必须是 drive-absolute path。
- 解析全局索引时不读取、`stat` 或解析任何 `configFile`；文件存在性、普通文件类型、UTF-8 和 JSON 只在 reference 被选中后验证。
- 不同 id 可以引用同一个 `configFile`；reference 路径不要求 lexical 或 realpath 唯一。

全局索引也不扫描 workspace 文件中的 `rootDir`、`otherRootDirs` 或 `port`，因此不施加跨 workspace 的 root 或端口唯一性约束。

---

## Workspace 选择

启动必须显式选择一个全局索引中的 id：

```text
custom-mcp --workspace <id>
```

`--workspace` 必须出现一次，并且 id 必须满足全局索引的 lexical grammar。无参数、重复参数、空值、含首尾 whitespace 的值、非法 token 都会由 CLI 拒绝。

`selectWorkspaceReference()` 按 id 查找唯一 reference。选择不依赖 `process.cwd()`，也不读取未选中 workspace 的配置文件。直接调用配置 loader 时传入的 `workspaceId` 也会进行同一 lexical 校验。

选中 reference 后，runtime identity 使用 reference 的 `id` 和 `configFile`；workspace 文件本身不定义或覆盖 id。selected workspace 文件的 schema 与运行时契约见 [workspace 配置](workspace-config.md)。

---

## 错误归属

以下失败归属全局索引文件：

- 全局文件不存在、不可读、不是普通文件、不是严格 UTF-8 文本或 JSON 无效；
- `version`、`workspaces`、reference 字段、id 唯一性或 `configFile` lexical 语义无效；
- 全局索引解析完成后，`--workspace` 对应 id 不存在，或传给 loader 的 id 违反 lexical grammar。

CLI 参数形式与 workspace id lexical grammar 在读取配置前以 `CliError` 拒绝，不归属配置文件。reference 已选中后，workspace 文件的读取、schema、path、env override 与策略文件错误归属该 workspace 配置文件。

---

## 验证重点

运行 `npm test -- config`，重点验证全局路径解析、reference schema 与 id 唯一性、CLI 显式选择，以及未选中 workspace 不触发文件读取。不同 id 复用同一配置文件、不同 workspace 复用 root 或端口均应保持合法。

测试约定见 [测试](../TESTING.md)。
