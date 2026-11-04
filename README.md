# agy-local-proxy

把**本机已登录的官方 Antigravity CLI**适配为 OpenAI Chat Completions / Anthropic Messages 服务。

```text
OpenAI / Anthropic API 调用方
          │ HTTP JSON / SSE
          ▼
本项目（127.0.0.1，独立代理 API key）
          │ ACP JSON-RPC stdio
          ▼
本机官方 agy acp ── 官方 OAuth / 官方请求链路 ── 官方服务
          │ MCP stdio
          ▼
临时工具桥接器 ── 挂起调用 ── API 调用方执行工具并提交结果
```

**不会提取 token，不会模拟 OAuth，不会直接请求 Google 推理接口。** OAuth、刷新与上游请求完全由官方客户端处理。本项目启动独立的本地 `agy acp` 子进程，并不是连接桌面 GUI 中已有的聊天窗口。仅使用你有权使用的账户，遵守服务条款与配额。

## 启动

需要 Node.js 20+ 和支持 `agy acp --stdio` 的官方 CLI。在**运行代理的同一用户环境**先完成官方登录：

```bash
agy
# 按官方交互完成 OAuth 登录后退出
export PROXY_API_KEY="$(openssl rand -hex 32)"
npm start
```

无第三方 npm 依赖，无需 npm install。可用 `AGY_BIN=/absolute/path/to/agy` 指定客户端。配置见 `.env.example`；它不会自动加载，也无需把 OAuth 凭据放入其中。如需文件配置，Node 20.6+ 可运行 `node --env-file=.env src/main.mjs`。不要把 API key 或 `.env` 提交到 Git。

默认监听 `127.0.0.1:8787`，拒绝监听公网地址。鉴权支持 `Authorization: Bearer <PROXY_API_KEY>` 和 `x-api-key`。`GET /healthz` 无鉴权，仅表示代理进程健康，不保证账户登录或上游可用。

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $PROXY_API_KEY"

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"default","messages":[{"role":"user","content":"你好"}],"stream":true}'

curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $PROXY_API_KEY" -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -d '{"model":"default","max_tokens":256,"messages":[{"role":"user","content":"你好"}],"stream":true}'
```

`model: default` 使用官方客户端当前默认模型；显式模型必须来自 `/v1/models`，不可用时不静默换模型。模型列表来自真实 `session/new`，会短暂启动一个官方进程。不实现模型名称冒充或账户无权访问的模型。

## 工具调用

支持 OpenAI `tools[].function` / `tool_calls` / `role: tool`，以及 Anthropic `tools[].input_schema` / `tool_use` / `tool_result`。请求中的工具定义注册到临时 MCP 服务；**工具代码由 API 调用方执行**，代理只传递 JSON 参数和文本结果。

## 本机 Claude Code 接入

已在本机安装独立 `claude-agy` 命令，原 `claude` 命令与 `~/.claude/settings.json` 保持不变。

```bash
claude-agy
AGY_MODEL=gemini-4-argon-high claude-agy
systemctl status agy-local-proxy
systemctl restart agy-local-proxy
systemctl stop agy-local-proxy
```

本机代理由 `agy-local-proxy.service` 管理，当前已启动，未设置开机自启。凭据在权限 0600 的 `~/.config/agy-local-proxy/{server,client}.env`，不存入仓库。服务和启动命令依赖当前工作树路径，请勿在试用期间删除工作树。

启动器默认 `--bare --tools default --permission-mode default`：保留标准工具和操作授权，跳过原有 hooks、CLAUDE.md 自动发现等功能。非 bare 模式下，本机 Claude Code 版本会注入非标准 `messages.role=system`，暂不支持。启动器关闭 thinking 与 prompt caching，并接受 Claude Code 的 metadata、ephemeral 缓存提示和 output_config.effort；metadata 不转发，缓存提示不保证缓存，实际思考强度以官方模型 ID 为准。

默认 `gemini-3.8-flash-low`。Claude Code 提示“不识别模型，假定 200k 上下文”属于自定义模型提示，不是连接失败；该窗口只是客户端假定值。token/费用显示为 0 代表未知，绝非实际免费。已验证 Claude Code 2.1.318 的普通文本与 Read 工具两轮闭环；未宣称所有工具/插件功能兼容。

## 工具续接规则

1. 初始请求携带 `tools`。返回 `finish_reason: tool_calls` 或 `stop_reason: tool_use`。
2. 调用方校验参数、执行工具。代理中的 MCP 调用持续等待，官方会话保留。
3. 将收到的 assistant 消息原样追加到完整历史，再追加工具结果。保持模型、system、工具定义、tool_choice 和协议不变。
4. 新请求关联原调用 ID，把结果送回原 MCP 调用，官方 Agent 继续生成。

OpenAI 的结果消息示例：

```json
{"role":"tool","tool_call_id":"call_...","content":"{\"weather\":\"sunny\"}"}
```

Anthropic 的结果消息示例：

```json
{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_...","content":"sunny","is_error":false}]}
```

支持多次连续工具往返。每个响应交付一个工具调用；已排队的其他 MCP 调用在后续响应串行交付。工具参数来自真实 MCP `tools/call`，不是解析模型输出的伪 JSON。SSE 支持 OpenAI `delta.tool_calls` 和 Anthropic `content_block_start` / `input_json_delta` / `content_block_stop`；完整参数作为一个增量发送，不声称参数逐 token 生成。

待结果会话默认保留 5 分钟，计入 `MAX_SESSIONS`。过期、服务重启、错误或不匹配历史会返回 409/400，不自动重放工具。请勿复用调用 ID 创建新分支；并发提交同一续接请求返回 409。不支持多个结果与新用户文本混合在一个 Anthropic message 中。

## 兼容范围与重要限制

这是真实可运行的 **Agent-to-API 适配器，不是无损的原生模型 API**。如果应用要求严格 token 上限、原生角色优先级或完全禁用 Agent 内建工具，当前方案不满足要求。

| 能力 | 状态 |
|---|---|
| `/v1/chat/completions`、`/v1/messages` | 文本 JSON / SSE |
| 客户端 function 工具往返 | 真实 MCP 挂起与恢复，两种协议均验证 |
| `tool_choice` auto / none | auto 注册工具；none 不注册调用方工具 |
| required / 指定工具 / Anthropic any | 限制暴露工具并提示引导；结束前没调用会显式报错，不保证原生强制采样语义 |
| `parallel_tool_calls` / `disable_parallel_tool_use` | 接受布尔值，但按单调用响应串行交付，不承诺批量并行或控制 Agent 内部调用生成 |
| JSON Schema | 原样注册 MCP；参数必须为 object；不实现完整校验，`strict: true` 拒绝 |
| `max_tokens` / `max_completion_tokens` | 兼容接受，**ACP 无硬上限映射，无法保证**；响应头 `x-agy-token-limit: not-enforced` |
| 用量 | 无可靠 ACP token 用量；OpenAI `usage: null`；Anthropic 必需字段为 0，表示未知而不是零消耗；头 `x-agy-usage: unavailable` |
| system/developer、历史角色 | 编码成 ACP prompt 的有角色 JSON，不等价于原生角色优先级；工具续接才保留原 ACP 上下文 |
| 原生工具、安全隔离 | 独立临时目录、`--sandbox`、关闭默认 customizations、不提供客户端文件/终端能力，拒绝非桥接授权；**不保证阻止无需授权的原生能力或用户全局配置** |
| metadata、ephemeral cache_control、output_config.effort | Claude Code 接入兼容提示；不提供缓存保证，effort 以所选官方模型档位为准 |
| 图片、音频、Responses API、采样参数、thinking、stop、logprobs、JSON response_format | 暂不支持，未知请求字段明确返回 400，不静默丢弃 |

官方客户端的全局规则、MCP、hooks、模型策略可能影响回答。真实验证中观察到用户全局规则产生时间戳前缀，代理保留原文。**不要向不可信用户开放这个服务，也不要认为 API key 或临时目录等同于 OS 沙箱。** 建议用专门的低权限 OS 用户/容器完成官方登录和运行，移除不需要的全局配置。只在工具回调中执行经过验证和授权的操作。

## 验证与维护

```bash
npm run check
PROXY_API_KEY="$PROXY_API_KEY" npm run smoke
# 可选：PROXY_BASE_URL=http://127.0.0.1:8787 SMOKE_MODEL=<真实模型 ID>
```

`smoke` 会**实际调用官方账户并消耗配额**，对两种协议分别做一次工具往返及 SSE 完成检查；不读账号凭据，不自动登录。服务须先启动。普通运行不会自动执行 smoke。构建证据及已知边界见 `implement-stage/BUILD_NOTE.md`。

默认总请求超时 180 秒，请求体 1 MiB，响应缓冲 2 MiB，最多四个官方进程。慢 SSE 消费者、取消、超时和进程退出会清理当前会话；等待工具结果的会话由 TTL 清理。不自动重试上游请求，避免重复工具调用或额外配额消耗。SIGTERM/SIGINT 会清理活动进程；Linux/macOS 同时清理子进程组，Windows 清理能力不同，尚未验证。

官方 Agent 内部请求预算耗尽（`max_turn_requests`）返回显式 upstream_error，不冒充 token 上限。容量释放包含子进程清理时间，完成请求后立即发新请求，在满容量时仍可能短暂得到 429。

## 参考

- [官方 Antigravity CLI](https://github.com/google-antigravity/antigravity-cli)：检查的公开仓库内容为文档、变更记录、示例，不包含完整 CLI 核心源码。
- [ACP 协议](https://agentclientprotocol.com/protocol/session-setup)：initialize、session/new、session/prompt、session/update。
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 与 [sub2api](https://github.com/Wei-Shaw/sub2api)：参考接口适配思路；其 token 直连上游实现不满足本项目约束，未复制其实现代码。

当前在 Linux、Node.js 20.19.2、Antigravity ACP Server 1.5.0 上验证。官方协议变化时请重新运行真实 smoke，不把历史验证当作所有版本兼容保证。
