# Android Build Tools

## 工具概览

本项目提供两个固定边界的 Android 构建工具：

- `android.assembleDebug`
- `android.testDebugUnitTest`

它们都在固定的 Android 工作目录中执行 `gradlew.bat`，只开放极少量参数，目标是让 AI 能稳定调用，而不是把它扩展成通用命令执行器。

---

## 参数契约

两个工具都只支持：

- `quiet?: boolean` → 追加 `-q`
- `stacktrace?: boolean` → 追加 `--stacktrace`
- `offline?: boolean` → 追加 `--offline`，要求 Gradle 使用已缓存的依赖

三个参数的默认值均为 `false`。

对应命令：

```powershell
.\gradlew.bat assembleDebug --no-daemon
.\gradlew.bat testDebugUnitTest --no-daemon
```

固定策略：

- 固定执行目录：`context.android.workspaceRoot`
- 固定使用：`gradlew.bat`
- 固定注入：`JAVA_HOME`（值来自 `context.android.javaHome`）
- 固定追加：`--no-daemon`
- 不开放任意 task、任意命令、任意环境变量透传

`offline: true` 控制 Gradle 的离线依赖解析；Gradle Wrapper 在本地缺少指定 distribution 时仍可能先执行下载，因此该参数不构成进程级网络隔离。

---

## 配置与返回

工具从 `ToolRuntimeContext.android` 获取已归一化的 Android 配置，不直接读取配置文件或环境变量。配置层负责从当前选中 workspace 构建 runtime snapshot；如果 selected workspace 的 `envOverrides.allowedFields` 允许对应 `android.*` 字段，snapshot 中的 Android 配置可能已应用合法 env override。

Android 配置边界：

- `android.workspaceRoot` 和 `android.javaHome` 使用 Typed Path existing-directory 语义；配置文件值和 allowlisted env override 都必须是已存在的本地绝对目录。
- Android env var 不存在时不覆盖；存在但为空字符串、whitespace-only、含首尾 whitespace、path 不存在或 numeric grammar 非法时启动失败。
- Android numeric env var 必须精确匹配十进制正整数 grammar；配置文件中的 numeric 字段只接受 JSON number。
- `android.*` env override 只作用于 selected workspace allowlist，且不能创建缺失的 `android` 配置段。
- `gradlew.bat` readiness 不属于配置值语义；配置加载只确认 `android.workspaceRoot` 是已存在目录，具体 wrapper 检查仍在工具调用阶段执行。

成功时返回：

```text
BUILD SUCCESSFUL
```

失败时返回紧凑 JSON 文本（`JSON.stringify(failure)`，不缩进），并带 `isError: true`，字段包括：

- `success`
- `task`
- `command`
- `exitCode`
- `durationMs`
- `timedOut`
- `summary`
- `firstErrorBlock`
- `logTail`

---

## 限制

- 仅支持 Windows
- `context.android.workspaceRoot` 中必须存在 `gradlew.bat`
- Android 配置缺失不会阻止服务启动，但会在工具调用时报错，并提示为 selected workspace 补充 `android` 段
- Android 配置错误会指向当前全局配置文件中的 selected workspace

---

## 维护注意事项

维护时保持以下约束：

1. **超时必须杀整棵进程树**
   - 不能只结束最外层壳进程，否则 Gradle / Java 子进程可能继续在后台运行并持有锁。

2. **失败日志必须保留真实到达顺序**
   - 不能简单用 `stdout + stderr` 重建输出，否则 `firstErrorBlock` 和 `logTail` 可能失真。

3. **工具不读取环境变量**
   - Android env override 由配置层按 selected workspace 的 allowlist 应用；工具只消费 `ToolRuntimeContext.android`。

4. **不要把危险工作目录路径直接拼进 `cmd.exe /c`**
   - Windows 路径可能包含 `&`、`%...%` 等 `cmd` 敏感字符。
   - 实现通过 `cwd` 切到工作目录，再执行相对路径 `".\\gradlew.bat"`。

---

## 相关测试

Android 构建相关测试集中在 `test/android-build/`：

- `test/android-build/test-android-build-tools.ts`：工具参数校验、缺失配置、缺失 wrapper
- `test/android-build/test-android-gradle-output.ts`：输出裁剪、首个错误块、到达顺序
- `test/android-build/test-android-gradle-timeout.ts`：超时后终止整棵进程树
- `test/android-build/test-android-gradle-launcher.ts`：特殊 Windows 路径下的启动行为
