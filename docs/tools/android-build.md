# Android Build Tools

## 工具概览

本项目当前提供两个固定边界的 Android 构建工具：

- `android.assembleDebug`
- `android.testDebugUnitTest`

它们都在固定的 Android 工作目录中执行 `gradlew.bat`，只开放极少量参数，目标是让 AI 能稳定调用，而不是把它扩展成通用命令执行器。

---

## 参数契约

两个工具都只支持：

- `quiet?: boolean` → 追加 `-q`
- `stacktrace?: boolean` → 追加 `--stacktrace`

对应命令：

```powershell
.\gradlew.bat assembleDebug --no-daemon
.\gradlew.bat testDebugUnitTest --no-daemon
```

固定策略：

- 固定执行目录：`android.workspaceRoot`
- 固定使用：`gradlew.bat`
- 固定注入：`JAVA_HOME`（值来自当前 workspace 的 `android.javaHome`，或阶段 3 兼容桥接中的 `ANDROID_JAVA_HOME` 覆盖）
- 固定追加：`--no-daemon`
- 不开放任意 task、任意命令、任意环境变量透传

---

## 配置与返回

工具读取 `~/.custom-mcp/config.json` 中当前 workspace 的 `android` 配置段；阶段 3 的配置文件 schema 要求 `android` 一旦出现就必须字段完整。当前仍保留兼容桥接，支持以下旧环境变量覆盖，阶段 5 会替换为 allowlist：

- `ANDROID_WORKSPACE_ROOT`
- `ANDROID_JAVA_HOME`
- `ANDROID_BUILD_TIMEOUT_MS`
- `ANDROID_MAX_ERROR_BLOCK_CHARS`
- `ANDROID_MAX_LOG_TAIL_CHARS`

成功时返回：

```text
BUILD SUCCESSFUL
```

失败时返回精简 JSON 文本，并带 `isError: true`，字段包括：

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

- 当前仅支持 Windows
- `android.workspaceRoot` 中必须存在 `gradlew.bat`
- Android 配置缺失不会阻止服务启动，但会在工具调用时报错
- 仓库根目录 `config.json` 不再作为运行配置来源；Android 配置错误会指向当前全局配置文件

---

## 维护注意事项

这部分记录本次集成中已经踩过、后续不要回退的问题：

1. **超时必须杀整棵进程树**
   - 不能只结束最外层壳进程，否则 Gradle / Java 子进程可能继续在后台运行并持有锁。

2. **失败日志必须保留真实到达顺序**
   - 不能简单用 `stdout + stderr` 重建输出，否则 `firstErrorBlock` 和 `logTail` 可能失真。

3. **空环境变量要视为未设置**
   - 空字符串不能覆盖全局配置文件中的有效值，必须回退到文件配置。

4. **不要把危险工作目录路径直接拼进 `cmd.exe /c`**
   - Windows 路径可能包含 `&`、`%...%` 等 `cmd` 敏感字符。
   - 当前做法是通过 `cwd` 切到工作目录，再执行相对路径 `".\\gradlew.bat"`。

---

## 相关测试

Android 构建相关测试集中在 `test/android-build/`：

- `test/android-build/test-android-build-tools.ts`：工具参数校验、缺失配置、缺失 wrapper
- `test/android-build/test-android-gradle-output.ts`：输出裁剪、首个错误块、到达顺序
- `test/android-build/test-android-gradle-timeout.ts`：超时后终止整棵进程树
- `test/android-build/test-android-gradle-launcher.ts`：特殊 Windows 路径下的启动行为
