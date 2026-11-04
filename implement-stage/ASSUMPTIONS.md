# Assumption Ledger

ASK: never；EFFORT: balanced；ASSURANCE: draft。

| ID | 未确定项 | 选择 | Class | Source |
|---|---|---|---|---|
| A-001 | 是否允许导出 token 直连 | 不允许，所有推理由本机 agy ACP 执行 | semantic | user |
| A-002 | 兼容 API | OpenAI Chat Completions、Anthropic Messages，JSON 和 SSE | interface | user |
| A-003 | 谁执行调用方工具 | 调用方执行；通过 MCP 挂起调用并回传结果，绝不在代理中执行工具代码 | semantic | user |
| A-004 | 运行环境 | Node.js >=20，无第三方运行时依赖；默认仅 127.0.0.1，必须配置 API key | interface | default |
| A-005 | 会话延续 | 每次新聊天独立官方进程；工具调用期间保留进程。结果必须携带完整且匹配的历史和工具定义；过期、重启后返回明确错误，不伪造续接 | semantic | default |
| A-006 | 官方原生工具 | ACP 客户端不提供文件和终端能力，拒绝非桥接工具的授权请求；独立临时工作目录、sandbox、禁用默认 customizations，但不保证阻止不请求授权的内建工具或用户全局设置 | semantic | default |
| A-007 | 兼容性边界 | 仅文本与 function 工具；不支持的字段明确报错。max_tokens / max_completion_tokens 接受为兼容字段，但 ACP 无对应硬限制，不能保证原生 token 上限；不伪造 token 用量，Anthropic 未知用量为 0 并附响应头说明 | semantic | default |
| A-008 | 工具选取 | 默认 auto；none 不注册工具；required/指定工具通过限制暴露及提示引导，并在未调用时显式报错，不能保证裸模型级 tool_choice 语义 | semantic | default |
| A-009 | 资源限制 | 请求/输出大小上限、活动进程上限、总轮次超时、待工具结果 TTL；客户端断开取消当前工作；无自动重试以免重复计费/工具调用 | interface | default |
| A-010 | 角色与历史 | ACP 只有用户 prompt；初始 API 历史编码为有角色标签的 JSON 文本，不能实现原生 system/developer 优先级；工具续接保留原 ACP 上下文 | semantic | default |
| A-011 | 流式行为 | 文本实时增量；MCP 到达后输出完整 JSON 参数为一个增量；不把思考或原生工具进度当成 assistant 文本 | interface | default |
| A-012 | 多工具调度 | 每次 API 响应交付一个 MCP 调用，多个调用串行交付；parallel_tool_calls 和 disable_parallel_tool_use 接受布尔值，但不承诺同轮批量并行，且不能限制官方 Agent 内部生成顺序 | semantic | default |
| A-013 | 工具参数强约束 | 原样向 MCP 注册 JSON Schema，桥接层保证参数为 JSON object；不实现完整 JSON Schema 校验，不接受 strict=true；调用方须校验参数后执行工具 | semantic | default |
| A-014 | ACP 内部请求预算耗尽 | max_turn_requests 显式返回 upstream_error，不伪装成 max_tokens/length | semantic | sweep |
| A-015 | Claude Code 接入元数据 | 接受 Anthropic metadata（不转发账户标识）及 ephemeral cache_control（仅兼容提示，不提供缓存保证）；启动器关闭 thinking 和 prompt caching；独立 claude-agy 命令不修改原 claude 设置 | interface | default |
| A-016 | Claude Code output_config.effort | 仅接受已知 effort 提示，实际思考档位由所选官方 model ID 决定，不声称把 Claude effort 映射成 Gemini 推理预算；output_config 其他字段拒绝 | semantic | default |
| A-017 | 本机 Claude Code 隔离配置 | claude-agy 默认 --bare，跳过原有 hooks、CLAUDE.md 自动发现等增强功能；正常文件/命令工具可显式 --tools default。非 bare 本机版本会发送非标准 messages role=system，暂不宣称支持该模式 | interface | default |
