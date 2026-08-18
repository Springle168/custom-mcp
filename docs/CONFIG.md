# 配置开发说明

`custom-mcp` 使用两层配置：home-level 全局索引负责选择 workspace，独立 workspace 配置负责该 workspace 的运行参数与访问边界。本文是配置文档入口；字段契约和维护细节由下列专题文档承载。

---

## 文档导航

| 主题 | 文档 | 内容 |
|-|-|-|
| 配置概览 | 本文 | 两层模型、启动方式、加载边界与错误来源。 |
| 全局索引 | [全局 workspace 索引](config/global-index.md) | `~/.custom-mcp/config.json`、`version: 2` reference schema、workspace 选择。 |
| Workspace 配置 | [workspace 配置](config/workspace-config.md) | `version: 1` schema、文件访问策略、env override、runtime snapshot。 |

---

## 配置文件模型

服务固定从以下位置读取全局索引：

```text
~/.custom-mcp/config.json
```

Windows 上通常展开为 `%USERPROFILE%\.custom-mcp\config.json`。全局索引中的每个 reference 以 workspace id 关联一个独立 workspace 配置文件：

```text
~/.custom-mcp/config.json
  └─ workspaces[]: { id, configFile }
                         │
                         ▼
              <任意本地绝对路径的 workspace JSON 文件>
```

全局索引只保存 identity 与配置文件定位；workspace 文件不包含 `id`，其 runtime id 始终来自被选中的全局 reference。两类完整模板分别见 [全局索引示例](../examples/config.example.json) 与 [workspace 配置示例](../examples/workspace-config.example.json)。

---

## 启动与加载管线

启动使用且只使用分隔参数形式：

```text
custom-mcp --workspace <id>
```

`parseCliArgs()` 与配置 loader 都按同一 lexical grammar 校验 workspace id。加载管线由 `loadRuntimeConfigWithIdentity()` 组织：

```text
parseCliArgs()
  │
  ▼
getDefaultGlobalConfigPath() + getDefaultGlobalLogsDir()
  │
  ▼
读取并解析全局索引
  │
  ▼
parseGlobalConfig()
  │
  ▼
selectWorkspaceReference()
  │
  ▼
读取并解析 selected workspace 配置
  │
  ▼
compileWorkspaceFileAccessPolicy()
  │
  ▼
createRuntimeConfigIdentity()
  │
  ▼
applyEnvOverridesToWorkspace()
  │
  ▼
buildRuntimeConfigSnapshot()
```

全局索引解析仅验证所有 reference 的 schema 与 `configFile` lexical 路径语义。选择完成后才读取 selected workspace 文件及其策略文件；未选中 workspace 的文件不存在、不可读、JSON 损坏、schema 非法或策略文件无效，都不会阻止本次启动。

`RuntimeConfigIdentity` 固定记录全局索引路径、workspace 配置路径、workspace id、rootDir、host 与 port。环境变量覆盖在 identity 创建后应用，不能改变 workspace 选择或 identity。

配置文件和策略文件在启动期读取。`ConfigStore` 只暴露只读 snapshot 与 identity，不提供 watcher、reload apply 或 snapshot mutation API；修改配置或策略后需要重启服务。工具层只消费由 snapshot 派生的 `ToolRuntimeContext`，不直接读取配置文件。

---

## 错误来源

| 失败范围 | 错误归属 |
|-|-|
| CLI 参数形式或 workspace id lexical grammar 无效 | `CliError`；发生在配置读取之前。 |
| 全局文件不存在、全局版本、reference schema、重复 id、非法 `configFile`、已解析 id 的选择失败 | 全局 `config.json`。 |
| selected workspace 文件读取、JSON、schema、path、env override、file access policy | selected workspace 配置文件。 |

`ConfigError` 携带配置文件路径；字段级校验同时携带 field path。专题文档说明各自的字段与边界。
