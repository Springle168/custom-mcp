# Android Studio 集成说明

本文记录 `custom-mcp` 与 Android Studio MCP 宿主集成时的配置方式、工具名称规则，以及 Android Studio 的 MCP schema 转换层限制。

---

## Android Studio 集成

### 配置

Android Studio 的 MCP 配置文件位置参考官方文档，添加：

```json
{
  "mcpServers": {
    "custom-mcp-server": {
      "httpUrl": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

workspace `host` 缺省为 `127.0.0.1`；显式配置其他 IP 时，`httpUrl` 使用相同地址。IPv6 地址在 URL 中需要方括号，例如 `http://[::1]:3100/mcp`。

### 限制

- Android Studio **不支持 stdio 传输**，只能用 HTTP。
- 不支持 MCP Resources 和 Prompt Templates。
- 工具名称在 AI 侧会显示为 `mcp__{server_name}__{tool_name}` 格式。

### 工具名称控制

最终显示名由两处决定：

| 段 | 来源 | 文件 |
|-|-|-|
| 中间段 (server name) | `Server` 构造函数的 `name` | `src/index.ts` |
| 末段 (tool name) | 工具定义的 `name` | built-in 使用 `src/tools/definitions/*.definition.ts`；configured Tool 使用 Tool config 引用的 `toolDefinitionFile` |

`-` 会被 Android Studio 自动转为 `_`。

---

## MCP schema 转换层限制

### 问题描述

Android Studio 将 MCP `tools/list` 的 `inputSchema` 转换为宿主 Function Calling 格式时，**只保留第一层 `properties` 的 `description`**，嵌套在 `items.properties` 内的所有 `description` 会被静默丢弃。`minItems`、`maxItems` 等约束也一并丢失。

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
- 可运行 `node --import tsx test/tools/inspect-tools.ts` 查看原始 schema 结构，但该脚本无法模拟 Android Studio 的转换行为，需在宿主中实际验证。

工具开发总则见 [docs/TOOLS.md](TOOLS.md)。

---

## 故障排查

| 现象 | 可能原因 | 解决方案 |
|-|-|-|
| Android Studio 连接失败 | 服务器未启动 / 端口不对 | 确认 `npm run start` 正常运行，端口与 Android Studio MCP 配置一致 |
| 工具名显示不符合预期 | server name 或 tool name 被宿主转换 | 检查 `src/index.ts` 中的 server name 和工具定义的 `name`，注意 `-` 会被转为 `_` |
| 嵌套参数说明丢失 | Android Studio 转换层丢弃嵌套 `description` | 将嵌套字段语义上提到顶层 `description`，并在宿主中实际验证 |
