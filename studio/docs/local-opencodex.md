# WorkStudio 接入本机 OpenCodex

WorkStudio 的内置 GPT 渠道可复用 Codex 已配置的本机 OpenCodex。它读取 `CODEX_HOME`（默认 `~/.codex`）的 `config.toml` 中的路由和模型目录元数据，不修改该文件，不复制登录令牌，不枚举原生聊天。

自动适配仅在没有显式 `profile` / `model_provider`，模型目录名为 `opencodex-catalog.json`，且 `openai_base_url` 指向带端口的 HTTP 回环 `/v1` 地址时启用。远端地址、带凭据或查询参数的地址不自动启用。已有自定义渠道保持原配置。

内置 `codex-default` 的 ID 不变，运行时使用独立 provider `workstudio-opencodex`，明确设置 `requires_openai_auth=false`，不读取或转发 ChatGPT 凭据。线程创建、分支、重连和恢复均明确指定当前 provider，避免旧 WorkStudio 聊天恢复时退回 ChatGPT 订阅渠道。设置 → 模型可查看实际请求地址与来源。

OpenCodex 需自行保持运行。该适配不会安装、启动或重启代理；代理不可用时请求失败，不自动改用官方服务或其他模型。修改本机路由后，在任务空闲时重新启动 WorkStudio Host。

## 本机验证（2026-11-18）

- 代理 `http://127.0.0.1:10100/v1`；WorkStudio 使用 npm Codex CLI 0.146.0。
- 隔离临时目录、全新 Codex home、无原生登录/历史、无 MCP、只读权限，仅发送短测试文本：`gpt-6.1-sol` 和 `gorilla-claude/claude-fable-5-1` 均成功返回。
- `gorilla-claude/claude-fable-5-2` 已到达代理，但上游返回 HTTP 400，要求 adaptive thinking 与 `output_config.effort`。本机该路由的 OpenCodex adapter 为 `openai-chat`。省略/关闭思考的另两次隔离探测均超时，不能据此认定模型可用。没有改写用户 OpenCodex 配置或偷偷替换型号/强度；该兼容性问题仍需代理/上游支持。
- 相关 46 项单测、类型检查和桌面构建通过；任务空闲时经正式关闭接口重启，核对 65 任务、79 会话、8 项目及 Jenkins/合作模式配置不变。

实现入口：`packages/host/src/runtime/codex/local-proxy.ts`、`host-process.ts`、`runtime/profiles.ts` 与 `runtime/codex/codex-runtime.ts`。
