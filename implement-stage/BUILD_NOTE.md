# Build Note

| Rung | 内容 | 验收 | Tier | Status |
|---|---|---|---|---|
| F0 | HTTP 健康检查与 ACP 初始化 | 临时启动 HTTP 并请求 /healthz；官方 initialize | MUST | passed |
| F1 | 双协议文本、模型列表与 SSE | 真实文本调用及协议检查 | MUST | passed |
| F2 | MCP 桥接工具挂起与恢复 | 真实客户端两种协议工具往返 | MUST | passed |
| F3 | 边界、资源清理、文档 | 非法请求/过期/取消/并发检查，审阅 | MUST | passed |

## Run record

- F0：Node 启动服务后 fetch /healthz 返回 200 和 status=ok，exit 0。初始 501 占位响应由 F1 真实处理器替换。
- F1：本机 /v1/models 返回六个真实模型；OpenAI 非流式返回 LOCAL_OK；Anthropic SSE 返回中文成功，事件顺序完整，exit 0。
- F2：OpenAI get_weather(city=Taipei) → 调用方返回 SUNNY_LOCAL_847 → 同会话回答 SUNNY_LOCAL_847，exit 0；Anthropic SSE lookup_code(place=Taiwan) → tool_result TW_LOCAL_592 → 同会话回答包含 TW_LOCAL_592，exit 0。
- 真实 Anthropic 回答出现官方客户端自定义时间戳前缀，说明全局规则仍可能影响输出；不在代理里删除/伪造模型文本。
- `PROXY_API_KEY=<temporary> PROXY_BASE_URL=http://127.0.0.1:18789 SMOKE_MODEL=gemini-3.8-flash-low npm run smoke`：两种协议真实工具往返及 SSE 完成通过，exit 0。
- 临时 Node assert 检查：Unicode/SSE 工具参数、错误请求、鉴权、未知端点、required 工具完成、MAX_SESSIONS 满容量/释放、历史不匹配、重放、工具 TTL、请求体上限、启动超时、多个连续工具调用，通过，exit 0。
- 边界验证首次在前一个响应结束后立刻启动新请求得到 429：清理未完成时容量仍占用属预期；加入 500ms 等待后确认容量释放。没有对上游自动重试。
- 真实 OpenAI SSE 工具参数测试通过；手动 SIGKILL 本次验证创建的官方子进程后，挂起会话容量释放；HTTP abort 后容量恢复，exit 0。
- 新鲜只读审阅发现 3 个问题：挂起时传输失败未立即释放、工具参数未计入响应上限、max_turn_requests 被误报 token 耗尽。已修复并用直接等待者回归检查和真实进程退出验证，exit 0。
- `npm run check`、`git diff --check` 通过。仓库原先没有测试套件，未新增测试框架；提供显式、会消耗账户配额的 `scripts/smoke.mjs`。
- 所有临时验证服务均停止；不留下使用验证 key 的监听端口。未修改官方客户端配置或凭据。

## Review assurance

规范 reviewer_route.py 在规定解析路径不存在；使用实际可用的 native fresh reviewer，未覆盖模型。模型身份未知，独立性未知，只作为 provisional 审阅；不得宣称跨家族独立验收。详见 SILENT_ASSUMPTION_SWEEP.json。

第二轮审阅确认输出上限和终止原因修复，另发现重复 close 提前释放容量、缓冲溢出绕过服务器释放两个生命周期问题；已改成共享清理 Promise，并让溢出也走 fatal disposal。执行者受控回归检查通过。两轮预算已用完，最后修复未再次独立审阅；最终剩余未声明 semantic 计数为 0，不能据此宣称独立 PASS。

最终生命周期修复后，再由临时本地服务运行 `scripts/smoke.mjs`：真实模型列表、OpenAI 和 Anthropic 工具往返及流式完成全部通过，exit 0；随后关闭该服务。

## Claude Code 本机接入

- 安装独立 claude-agy 启动器、0600 私有配置、systemd 服务（启动但不 enable）。原 Claude Code 设置不变。
- 真实 Claude Code 2.1.318：文字返回 CLAUDE_AGY_OK，exit 0；标准工具配置下 Read package.json，num_turns=2，返回 agy-local-proxy，exit 0。
- 非 bare 本机配置发送非标准 role=system；采用 --bare 隔离，保留 --tools default 和默认权限确认。不宣称原有 hooks/插件兼容。
- 增加 metadata、ephemeral cache_control、output_config.effort 接入兼容；含义见 A-015 至 A-017 和 README。

- 已检查官方仓库 c994f07d241d3b3b1902d5705008092beb00e099：目前公开内容为 README、CHANGELOG 与示例，并非完整 CLI 实现源码。
- 本机 `agy acp --stdio` 的 initialize 返回 Antigravity ACP Server 1.5.0；session/new 成功并返回可用模型。
- CPA 78a9cc9aaa8ae90a66300d9cbddfe7c894307622 和 sub2api 876b96d204855ad1aac486b7dd39a95d377d4760 的 Antigravity 实现直接添加上游 Authorization；仅参考其接口分层，不复用其认证/传输实现。
- 不提交 git commit，保留用户原有 read 文件。

## Deferred

Responses API、多媒体、原生 token 上限/采样控制、多账户池、生产多租户、跨重启工具恢复。

## Blockers

真实 ACP/MCP 工具注册和恢复已验证。完整原生 API 语义仍受官方 Agent 协议限制，详见 README。
