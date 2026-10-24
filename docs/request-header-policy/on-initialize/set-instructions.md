# setInstructions

`setInstructions` 是 `onInitialize` 阶段的功能，设置本会话 initialize response 的说明文本。绑定方式见[初始化规则](../../REQUEST-HEADER-POLICY.md#oninitialize)，header 解析与整体失败规则见[公共输入边界](../../REQUEST-HEADER-POLICY.md#请求头输入边界)。

## 参数与响应

绑定的请求头值必须是 JSON object，顶层仅允许必填 `instructions`，类型为 string。文本原样保留，不 trim、不追加默认文本、不模板展开。

缺失 header 或空字符串都不在 initialize response 中发送 instructions。metadata 能区分未应用与主动设置空值。非空文本通过 Server options 交给 SDK 序列化。长说明不适合经请求头传输。

## 作用边界

instructions 是本会话的说明数据，不是服务端命令或权限指令。服务端不执行文本、不传给 executor 或下游；客户端如何展示或交给模型使用由客户端决定。

后续请求不能修改说明，重新选择设置需要新会话。初始化准备与发布的共同生命周期见[请求头策略](../../REQUEST-HEADER-POLICY.md#初始化入口与发布)。
