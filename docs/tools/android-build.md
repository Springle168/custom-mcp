# Android Build Tools

## 工具概览

本项目提供两个固定边界的 Android 构建工具：

- `android_assembleDebug`
- `android_testDebugUnitTest`

它们都在固定的 Android 工作目录中执行 `gradlew.bat`，只开放少量诊断参数，目标是让 AI 稳定调用，而不是扩展成通用命令执行器。

---

## 参数契约

两个工具都支持：

- `quiet?: boolean` → `true` 时追加 `-q`，默认 `true`
- `stacktrace?: boolean` → `true` 时追加 `--stacktrace`，默认 `false`
- `offline?: boolean` → `true` 时追加 `--offline`，要求 Gradle 使用已缓存的依赖，默认 `false`
- `includeLogTail?: boolean` → 失败时附加有长度上限的原始诊断尾部，默认 `false`

默认命令：

```powershell
.\gradlew.bat assembleDebug -q --no-daemon --console=plain
.\gradlew.bat testDebugUnitTest -q --no-daemon --console=plain
```

固定策略：

- 固定执行目录：`context.android.workspaceRoot`
- 固定使用：`gradlew.bat`
- 固定注入：`JAVA_HOME`（值来自 `context.android.javaHome`）
- 固定追加：`--no-daemon`、`--console=plain`
- 不开放任意 task、任意命令、任意环境变量透传

`quiet=false` 只提高 Gradle 产生的日志详细度，不改变返回字段语义。`includeLogTail` 只控制失败 JSON 是否携带日志尾部，进程输出始终会被捕获并用于默认错误解析。

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

成功只由 Gradle 进程退出码 `0` 判定。工具不建立 `EXECUTED`、`UP-TO-DATE`、`NO-SOURCE` 或 `FROM-CACHE` 等稳定返回契约。

失败时返回紧凑 JSON 文本（`JSON.stringify(failure)`，不缩进），并带 `isError: true`。共享字段包括：

- `success`
- `task`
- `command`
- `exitCode`
- `durationMs`
- `timedOut`
- `summary`
- `failedTask`
- `firstErrorBlock`

`failedTask` 是 best-effort 提取的 Gradle task path，例如 `:app:compileDebugKotlin`；无法识别时为 `null`。它不附加启发式任务分类。

`firstErrorBlock` 优先保留具体编译器、Android 构建或测试诊断。默认诊断会去除 Gradle 的 `FAILURE: Build failed with an exception.`、`* What went wrong:` 标题、结构化后的 failed task 外壳、`* Try:` section 和固定构建尾部。输出格式无法识别时安全退化，不影响退出码所表达的失败语义。

`includeLogTail=true` 时额外返回 `logTail`：

- 保留 stdout/stderr 的真实到达顺序
- 清除 ANSI escape sequence 并统一换行
- 保留 Gradle 原始 failure template
- 使用 `android.maxLogTailChars` 限制长度并标记截断

默认结果直接省略 `logTail` 属性，不返回 `null`。

---

## 单元测试失败报告

`android_testDebugUnitTest` 在 Gradle 调用前后比较工作区内 JUnit XML 报告，只把本次新建或发生变化的文件归因于本次失败。`android_assembleDebug` 不执行报告扫描。

报告发现基准固定为：

```text
context.android.workspaceRoot
```

候选模式：

```text
**/test-results/testDebugUnitTest/TEST-*.xml
```

该模式不固定 `app` 或 `build`，支持常见多模块布局、project directory remap 和工作区内自定义 build directory。发现过程排除 `.git/`、`.gradle/`、`node_modules/`，不读取符号链接报告或工作区外文件。

调用前快照记录报告路径、大小和修改时间；调用后未变化的旧报告不会进入本次失败结果。多个模块在同一次调用中生成报告时，工具按确定路径顺序聚合全部变化 XML。

同一 Android workspace 的多个 `android_testDebugUnitTest` 调用如果执行窗口发生重叠，会继续并发运行 Gradle，但所有重叠调用都放弃 XML 报告归因，避免把另一轮生成的报告误归因到自身；各调用仍保留自己的 Gradle 文本诊断。报告发现最多接受 1000 个候选文件，单文件与总读取量均在打开文件后通过有界读取再次强制检查，超过任一预算时安全退化。

测试失败可额外返回：

```json
{
  "testReport": {
    "status": "generated",
    "reportFiles": 2,
    "tests": 42,
    "failures": 3,
    "errors": 1,
    "skipped": 2,
    "failedTests": [
      {
        "className": "example.ExampleTest",
        "name": "computed value matches expectation",
        "type": "java.lang.AssertionError",
        "message": "Expected <2>, actual <1>.",
        "location": "ExampleTest.kt:24"
      }
    ],
    "omittedFailedTests": 0
  }
}
```

报告状态：

- `generated`：至少一个本次变化 XML 形成可信汇总
- `not_generated`：失败 task 是固定的 `testDebugUnitTest`，但没有发现本次变化的受支持 XML
- `parse_failed`：发现本次变化报告，但没有报告能够形成可信汇总，或报告读取失败

`<failure>` 与 `<error>` 都进入 `failedTests`，但 `failures` 和 `errors` 分别统计。失败详情默认最多返回前 10 项，超出的数量记录在 `omittedFailedTests`。默认详情不返回完整 stack、`system-out` 或 `system-err`。

测试 XML 中的首个失败优先成为 `firstErrorBlock`。前置编译 task 失败且报告未变化时，结果省略 `testReport`，不会把旧测试失败归因于本次调用。

JUnit XML 被禁用、写到工作区外或使用完全自定义目录时，工具不会解析 Gradle DSL、注入 init script 或扫描工作区外路径；失败结果通过 `firstErrorBlock` 和可选 `logTail` 安全退化。

---

## 限制

- 仅支持 Windows
- `context.android.workspaceRoot` 中必须存在 `gradlew.bat`
- Android 配置缺失不会阻止服务启动，但会在工具调用时报错，并提示为 selected workspace 补充 `android` 段
- Android 配置错误会指向当前全局配置文件中的 selected workspace
- 测试报告发现只支持 Android workspace 内匹配既定模式的 JUnit XML
- 单个和全部报告读取均有大小上限；过大或不可读报告不会覆盖真实 Gradle 失败

---

## 维护注意事项

维护时保持以下约束：

1. **超时必须杀整棵进程树**
   - 不能只结束最外层壳进程，否则 Gradle / Java 子进程可能继续在后台运行并持有锁。

2. **失败日志必须保留真实到达顺序**
   - 不能简单用 `stdout + stderr` 重建输出，否则 `firstErrorBlock` 和 `logTail` 可能失真。

3. **退出码是成功失败的权威依据**
   - 文本和 XML 解析只增强诊断；解析失败不得覆盖 Gradle 退出码、启动错误或超时。

4. **旧测试报告不得归因于本次调用**
   - 测试报告必须通过调用前后快照判定为本次新建或变化，不能只在失败后读取现存 XML。

5. **工具不读取环境变量**
   - Android env override 由配置层按 selected workspace 的 allowlist 应用；工具只消费 `ToolRuntimeContext.android`。

6. **不要把危险工作目录路径直接拼进 `cmd.exe /c`**
   - Windows 路径可能包含 `&`、`%...%` 等 `cmd` 敏感字符。
   - 实现通过 `cwd` 切到工作目录，再执行相对路径 `".\\gradlew.bat"`。

---

## 实现入口

- `src/tools/android-build-shared.ts`：共享 input schema、调用编排和失败 JSON
- `src/utils/android-gradle.ts`：Gradle 进程、命令参数、超时与原始输出
- `src/engine/android-gradle-output.ts`：纯文本失败解析
- `src/utils/android-test-report-files.ts`：测试报告发现、快照与变化文件读取
- `src/engine/android-test-report.ts`：JUnit XML 解析、聚合和失败详情

---

## 相关测试

Android 构建相关测试集中在 `test/android-build/`：

- `test/android-build/android-build-tools.test.ts`：工具参数、返回契约和测试报告编排
- `test/android-build/android-gradle-output.test.ts`：输出清洗、failed task、首个错误块、log tail 和到达顺序
- `test/android-build/android-test-report.test.ts`：JUnit XML 聚合、失败详情和解析退化
- `test/android-build/android-test-report-files.test.ts`：报告发现、调用前后变化与旧报告过滤
- `test/android-build/android-gradle-timeout.privileged.ts`：超时后终止整棵进程树
- `test/android-build/android-gradle-launcher.test.ts`：特殊 Windows 路径下的启动行为

进程树终止测试需要允许 `taskkill /t /f` 终止测试创建的完整 Windows 进程树，不由 `npm test` 执行。在满足权限前提的环境中显式运行：

```bash
node --import tsx test/android-build/android-gradle-timeout.privileged.ts
```
