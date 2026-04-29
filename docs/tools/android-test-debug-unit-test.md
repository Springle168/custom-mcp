# android.testDebugUnitTest

## 功能

在固定的 Android 工作目录中执行：

```powershell
.\gradlew.bat testDebugUnitTest --no-daemon
```

可选参数：

- `quiet?: boolean` → 追加 `-q`
- `stacktrace?: boolean` → 追加 `--stacktrace`

工具不会开放任意 task、任意命令或任意环境变量透传。

---

## 配置来源

优先读取 `config.json` 中的：

```json
{
  "android": {
    "workspaceRoot": "E:/AndroidStudioProjects/YourProject",
    "javaHome": "E:/Android_Studio/jbr"
  }
}
```

也支持环境变量覆盖：

- `ANDROID_WORKSPACE_ROOT`
- `ANDROID_JAVA_HOME`
- `ANDROID_BUILD_TIMEOUT_MS`
- `ANDROID_MAX_ERROR_BLOCK_CHARS`
- `ANDROID_MAX_LOG_TAIL_CHARS`

---

## 返回约定

### 成功

返回单段文本：

```text
BUILD SUCCESSFUL
```

### 失败

返回精简后的 JSON 文本，并带 `isError: true`。字段包括：

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
- 固定执行 `testDebugUnitTest`
- 固定使用 `gradlew.bat`
- 固定注入 `JAVA_HOME`
- 固定追加 `--no-daemon`
