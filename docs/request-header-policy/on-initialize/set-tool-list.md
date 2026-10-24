# setToolList

`setToolList` 是 `onInitialize` 阶段的功能，用客户端请求的工具名称收窄本会话的工具集合。绑定方式见[初始化规则](../../REQUEST-HEADER-POLICY.md#oninitialize)，header 解析与整体失败规则见[公共输入边界](../../REQUEST-HEADER-POLICY.md#请求头输入边界)。

## 参数契约

绑定的请求头值必须是 JSON object，顶层仅允许必填 `toolList`，类型为 string 数组。名称 grammar 是 `^[A-Za-z0-9._-]{1,128}$`，区分大小写、不 trim；重复名称无效。空数组合法。

## 会话工具集合

设 workspace 已暴露集合为 `W`，客户端请求集合为 `H`，会话集合为 `S`：

- header 缺失时，`S = W`。
- header 合法时，`S = W ∩ H`。
- `toolList: []` 或所有名称均被过滤时，`S` 为空。

grammar 合法但未在 `W` 中暴露的名称正常过滤，不透露它属于未定义还是被禁用。列表顺序按 workspace definitions view 保留，客户端数组不控制排序。

选择依据是调用名称而非 definition reference id，适用于内置与 custom-only 工具。不能重新启用 workspace 禁用工具、替换 definition 或改变 external binding。

## 准入与资源边界

会话视图的同一集合同时约束 `tools/list` 与 `tools/call`。不在集合内的调用返回标准 `Unknown tool: <name>` 错误结果，不进入 validator 或 executor；该结果仍经过本次[工具结果阶段](../../REQUEST-HEADER-POLICY.md#启动与调用)。

会话只持有受限视图，validators、executors 与共享运行资源继续归 workspace service 所有。设置在会话内固定，不提供会话内更新或 `tools/list_changed` 通知；空工具集合也不撤销 MCP Server 的 `tools: {}` capability。
