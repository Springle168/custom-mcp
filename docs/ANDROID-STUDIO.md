# Android Studio 集成说明

本文记录 `custom-mcp` 与 Android Studio MCP 宿主集成时的配置方式、工具名称规则，以及 Android Studio MCP → Gemini 转换层限制。

---

## Android Studio 集成

### 配置

Android Studio 的 MCP 配置文件位置参考官方文档，添加：

```json
{
  "mcpServers": {
    "custom-mcp-server": {
      "httpUrl": "http://localhost:3100/mcp"
    }
  }
}
```

### 限制

- Android Studio **不支持 stdio 传输**，只能用 HTTP。
- 不支持 MCP Resources 和 Prompt Templates。
- 工具名称在 AI 侧会显示为 `mcp__{server_name}__{tool_name}` 格式。

### 工具名称控制

最终显示名由两处决定：

| 段 | 来源 | 文件 |
|-|-|-|
| 中间段 (server name) | `Server` 构造函数的 `name` | `src/index.ts` |
| 末段 (tool name) | 工具定义的 `name` | 各工具文件 |

`-` 会被 Android Studio 自动转为 `_`。

### 与 Android Studio 内置工具的覆盖分析

Android Studio 已内置以下工具，通常无需额外移植：

| Gemini CLI 工具 | Android Studio 内置对应工具 |
|-|-|
| `read_file` | `read_file` |
| `write_file` | `write_file` |
| `list_directory` | `list_files` |
| `glob` | `find_files` |
| `grep_search` | `grep` |

注：尽管 Android Studio 已内置 `write_file`，本仓库仍提供同名 server-side 工具，用于统一写入流程、保持与 `replace_text` 的配套体验，并在宿主不使用内置能力时保持可用。

---

## MCP → Gemini 转换层限制

### 问题描述

Android Studio 将 MCP `tools/list` 的 `inputSchema` 转换为 Gemini Function Calling 格式时，**只保留第一层 `properties` 的 `description`**，嵌套在 `items.properties` 内的所有 `description` 会被静默丢弃。`minItems`、`maxItems` 等约束也一并丢失。

受影响的结构示例：

```text
properties
└── questions (ARRAY)          ← description ✓ 保留
    └── items.properties
        ├── question (STRING)  ← description ✗ 丢失
        ├── type (STRING)      ← description ✗ 丢失
        └── options (ARRAY)
            └── items.properties
                └── label      ← description ✗ 丢失
```

扁平结构（如 `replace_text`、`read_many_files`）不受影响。

### 规避方案

凡是含有嵌套 `items.properties` 的工具，必须在顶层 `description` 中用纯文本描述所有嵌套字段的语义、类型、取值范围和使用条件。`inputSchema` 本身保持完整，仍负责结构校验；顶层 `description` 负责向 AI 传达语义。

当前受影响工具：`ask_user`（已按此方案处理）。

### 新增工具时的检查项

- 若工具 schema 含有嵌套对象数组（`array` of `object`），必须将嵌套字段的说明上提到顶层 `description`。
- 可运行 `npx tsx test/inspect-tools.ts` 查看原始 schema 结构，但该脚本无法模拟 Android Studio 的转换行为，需在宿主中实际验证。

工具开发总则见 [docs/TOOLS.md](TOOLS.md)。

---

## 故障排查

| 现象 | 可能原因 | 解决方案 |
|-|-|-|
| Android Studio 连接失败 | 服务器未启动 / 端口不对 | 确认 `npm run start` 正常运行，端口与 Android Studio MCP 配置一致 |
| 工具名显示不符合预期 | server name 或 tool name 被宿主转换 | 检查 `src/index.ts` 中的 server name 和工具定义的 `name`，注意 `-` 会被转为 `_` |
| 嵌套参数说明丢失 | Android Studio 转换层丢弃嵌套 `description` | 将嵌套字段语义上提到顶层 `description`，并在宿主中实际验证 |
