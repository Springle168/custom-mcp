# Gemini CLI 移植参考

本文记录继续移植 Gemini CLI 能力到 `custom-mcp` 时的通用参考路径和裁剪原则。

---

## 移植通用注意事项

1. **定位 Schema**：所有工具的参数描述统一在 `packages/core/src/tools/definitions/model-family-sets/gemini-3.ts` 中，按工具名搜索即可找到完整 `description` 和 `inputSchema`。
2. **定位实现**：工具执行逻辑在 `packages/core/src/tools/<toolName>.ts`。
3. **移除框架依赖**：原版工具依赖 `Config`、`MessageBus`、`AbortSignal` 等 Gemini CLI 内部对象，移植时用本项目的 `Config` 和直接的 `fs` 调用替代。
4. **移除遥测**：删除所有 `logEditStrategy()`、`EditStrategyEvent` 等调用。
5. **async 清理**：原版部分函数标记 `async` 但无实际异步操作，可视情况简化。

---

## 本项目移植约定

- 工具开发流程和 schema 设计约定见 [docs/TOOLS.md](TOOLS.md)。
- 单个工具的移植来源优先记录在 `docs/tools/` 下对应工具文档。
- Android Studio 宿主限制见 [docs/ANDROID-STUDIO.md](ANDROID-STUDIO.md)，尤其注意嵌套 schema 的 `description` 丢失问题。
- `ask_user` 的历史实现交接记录见 [docs/ask_user 工具实现交接文档.md](ask_user%20工具实现交接文档.md)。
