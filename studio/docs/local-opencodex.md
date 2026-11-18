# WorkStudio 接入本机 OpenCodex

WorkStudio 的内置 GPT 渠道可复用 Codex 已配置的本机 OpenCodex。它读取 `CODEX_HOME`（默认 `~/.codex`）的 `config.toml` 中的路由和模型目录元数据，不修改该文件，不复制登录令牌，不枚举原生聊天。

自动适配仅在没有显式 `profile` / `model_provider`，模型目录名为 `opencodex-catalog.json`，且 `openai_base_url` 指向带端口的 HTTP 回环 `/v1` 地址时启用。远端地址、带凭据或查询参数的地址不自动启用。已有自定义渠道保持原配置。

内置 `codex-default` 的 ID 不变，运行时使用独立 provider `workstudio-opencodex`，明确设置 `requires_openai_auth=false`，不读取或转发 ChatGPT 凭据。线程创建、分支、重连和恢复均明确指定当前 provider，避免旧 WorkStudio 聊天恢复时退回 ChatGPT 订阅渠道。设置 → 模型可查看实际请求地址与来源。

OpenCodex 需自行保持运行。该适配不会安装、启动或重启代理；代理不可用时请求失败，不自动改用官方服务或其他模型。修改本机路由后，在任务空闲时重新启动 WorkStudio Host。

## 本机验证（2026-11-18）

- 代理 `http://127.0.0.1:10100/v1`；WorkStudio 使用 npm Codex CLI 0.146.0。
- 隔离临时目录、全新 Codex home、无原生登录/历史、无 MCP、只读权限，仅发送短测试文本：`gpt-6.1-sol` 和 `gorilla-claude/claude-fable-5-1` 均成功返回。
- `gorilla-claude/claude-fable-5-2` 的旧 `openai-chat` 路由发送 `reasoning_effort`，上游转换后返回 adaptive thinking 的 HTTP 400。随后经 OpenCodex 正式管理 CLI 将本机 `gorilla-claude` 的 adapter 热更新为 `anthropic`（地址、密钥和型号不变），低/高档位分别正确生成 `thinking.type=adaptive` 与对应 `output_config.effort`。正确 adapter 的低档位短请求实际返回 OK。
- 该参数修正不等于 Fable 5.2 已稳定可用：修正后的完整 app-server 高档位测试超时，代理的短请求低/高档位返回上游 504，直接高档位探测返回 502 `Upstream service temporarily unavailable`。必须保留该服务可用性问题，不能宣称全部修好。修改后的完整 app-server 回测中，Fable 5.1 和 GPT‑6.1 Sol 均成功返回。没有重发用户任务、替换型号或降低用户选择的强度。
- 相关 46 项单测、类型检查和桌面构建通过；任务空闲时经正式关闭接口重启，核对 65 任务、79 会话、8 项目及 Jenkins/合作模式配置不变。

实现入口：`packages/host/src/runtime/codex/local-proxy.ts`、`host-process.ts`、`runtime/profiles.ts` 与 `runtime/codex/codex-runtime.ts`。

## Claude adaptive thinking 的本机配置

此配置在本机 OpenCodex 中生效，不随 WorkStudio 源码提交。只有该渠道的上游确实支持 Anthropic Messages 时才使用；不能一律改写所有第三方渠道。

```powershell
opencodex provider edit gorilla-claude --adapter anthropic --json
```

这是正式管理 API 的字段补丁，不修改密钥，在线生效，不需重启 WorkStudio 或代理。该渠道的 Claude 型号共用转换器，因此修改后同时回测已有型号。若需恢复原转换器，用相同命令指定 `--adapter openai-chat`。本机非敏感回退记录为 `D:\Codex\workstudio-opencodex-adapter-rollback.json`。

参数规范见 [Claude adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)。省略思考参数或静默改用其他模型，均不能作为所选型号/强度已经可用的验证。
