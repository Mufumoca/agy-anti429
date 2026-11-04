# 本地 Antigravity API 适配器

基线提交：ecdae547549dbab56a95dea394669fa1994a4ff9

输入：本机已完成 OAuth 登录的官方 `agy`，OpenAI Chat Completions 或 Anthropic Messages 请求。
输出：`/v1/chat/completions`、`/v1/messages` JSON/SSE；真实模型列表；工具调用与工具结果往返。
硬约束：推理只能由本机官方进程发起；代理不读取、刷新、导出 OAuth 凭据，不实现云端 HTTP 客户端。
实现：Node.js 20 标准库 HTTP → ACP stdio → 官方 agy。请求提供的工具通过临时 MCP stdio 服务注册；调用在 MCP 服务内等待 API 调用方提交结果。
验证：语法检查、临时协议驱动检查、已登录客户端上的真实文本和工具闭环。检查命令和输出见 BUILD_NOTE.md。
范围：单用户本地服务、文本、客户端工具。暂不实现 Responses API、图片、音频、平台计费、多账号管理、完整采样控制。ACP 是 Agent 协议，不能宣称与原生模型 API 完全等价。
