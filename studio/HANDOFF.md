# 交接：AMO 的当前状态

新会话先读这份。长期有效的规则在仓库根目录的 `AGENTS.md`；这里只写**现在**的状态和还开着的事，不记改动流水（2026-11-06 用户定）：改了什么看 `git log` 和各包 `CHANGELOG.md`。做完一段，只改下面受影响的行（状态变了、事做完了就删掉那一行、新开的事加一行）。

找功能在哪：`node scripts/nav.mjs --query 关键词`（导航索引，`docs/nav/`）。查某个功能当初为什么这么做：先看 `plans/` 里对应方案开头的状态和正文的决定，再在 `docs/history/`（11-06 之前的交接记录：`handoff-2026-10.md`、`handoff-2026-10-late.md`、`handoff-2026-11.md`）、`plans/done/`、`docs/archive/`（/loop 时期）里搜。文档怎么分层见 `plans/doc-architecture.md`。

## 在哪、怎么跑

| 项目 | 内容 |
|---|---|
| 开发目录 | `G:\PROJECT\AgentMonitorOverlay\studio`（桌面快捷方式「AMO Source」指这里的 `start-studio.cmd`） |
| 分支 | `master` 是主线；旧版 AMO 在标签 `amo-legacy-final` |
| kingkunkun fork | 本机 `D:\Codex\AgentMonitorOverlay`；origin 仅 `kingkunkun/AgentMonitorOverlay`，upstream 禁止推送。上游同步基线 `455720b4`。已启用独立手机远程、归档与原生隐私限制、Jenkins 参数化接口修复。11-12 移除旧桌宠，另加用户图片的15分钟活动提醒，设置可关闭/预览/收起；透明半屏高图片移动30秒，不拦点击或读取键鼠。只重载外壳，原 Host 43776 保持，shell 48140；48 任务/48 会话未变。实际操作前重读 `.data/*.json`。完整 portable 为 `release/workstudio-break-reminder-20261112/WorkStudio/`，桌面快捷方式仍启动源码版；原数据备份 `.data/backup-before-newui-restart-20261111204247`。 |
| Work中转 / 合作模式（本机集成） | 团队账号仍登录；团队远程/中转关闭，手机服务开启并允许 LAN，已有 1 个独立手机账号。仅未归档的 WorkStudio 自建聊天可下载，旧原生导入及后代不共享，文件外发仍由电脑确认；不是 OS 沙箱。见 `docs/mobile-privacy-audit.md`。11-13 MI 8 通过 USB 安装 WorkStudio 0.2.3 / build 7，安装前正式包不存在，属新安装，手机登录未验证；沿用原包名和调试签名。不能操作正式账号跑仪器测试，测试包使用 `.qa`。新版仪器测试入口 `MobileRefreshUiTest`，旧 `UiFlowTest` 流程需迁移。iOS 共用代码已改，IPA 未构建；Tailscale/5G 未实测。真实 Jenkins 仅 GET 核对参数定义，不曾重试提交构建。 |
| 常设 worktree | 都是 master 的 detached worktree：值守目录 `G:\PROJECT\AgentMonitorOverlay-duty`（值守修问题、`release land`）、打包目录 `G:\PROJECT\AgentMonitorOverlay-release`（自动打包跑 `release auto --if-due`）。别的 worktree 是各任务自己的（`git worktree list` 看） |
| 用户在用的 Studio | 平台装的版本（`D:\TOOLS\AMO Platform\apps\studio\<版本>`），不是这个开发目录：在这里改代码、build 都不影响它；提交进 master 且写了「下一版」的会被自动打包发到测试通道，用户自己选装 |
| 开发版 | `npm start`（先 build 再开窗口），数据在 `studio\.data`。Host 常驻在 47900 端口；改了 Host 代码要先 `npm run host:stop` 再 `npm start` |
| 帮用户重启开发版 | **先问用户，而且只在没有会话运行时做**。`npm run build` → `npm run host:stop` → 结束 `electron.exe packages/app` 主进程（命令行不含 `--type=`）→ 备份 `.data\studio.db*` 到 `.data\backup-before-<名字>-<日期>` → 在 PowerShell 里先删掉匹配 `^(CLAUDE|ANTHROPIC_|AMO_STUDIO_|NO_COLOR$|FORCE_COLOR$|COLOR$|TERM$)` 的环境变量（Claude Code 工具 shell 带的，Studio 会传给维护终端）→ `Start-Process node_modules\electron\dist\electron.exe packages/app`（工作目录 `studio`）→ 用 `.data/host-token` 在 node 脚本里查 `GET /api/state` 核对任务和会话数（不打印令牌）。只改界面时让用户按 Ctrl+R 即可 |
| 验证 | `npm run verify`（typecheck + vitest + build）；`npm run e2e`（Playwright project：`studio`、`notes`、`reviewer`、`relay`、`platform`）。都用 BelowNormal 优先级、`--maxWorkers=6` |
| 发布 | 都走 `npm run release`（用法在 `scripts/release.mjs` 开头，节奏见 `plans/release.md`）。自动打包每 60 秒跑 `release auto --if-due`，只发「下一版」里有条目的工具。各工具现在的版本：`npm run release -- status` |
| AMO 中转 | 服务在 Mac mini `http://172.16.8.85:47120/`（SSH 别名 `mac`）。部署：`npm run release -- relay-service`（会重启中转几秒，先问用户）；底层命令和服务器上的位置见 `packages/relay/README.md` |

## 规则补充（`AGENTS.md` 之外的细节）

- 不改 `~/.codex/config.toml`、`~/.claude/` 设置、用户已有的凭据条目（Studio 只写用户在 设置 → 模型 加渠道时的 `channel-<id>` / `channel-<id>-access`）。
- 测试只在 `%TEMP%\amo-studio-sandbox\` 和临时目录；端口只用 47900–47999；测试窗口不抢焦点、不开终端/浏览器、不碰剪贴板。
- 不 reset --hard、不删分支。密钥不打印、不写日志/文件/命令行。
- **真实模型额度**（`budget.json`，用 `spikes/lib.mjs` 的 `countTurn(note, provider)` 先计数再调用，以文件为准）。平时测试用 mock。
- 工具坑：heredoc 里的 Python 会吃掉 `\n`、`\v` 等转义 → 有转义的改动用 Edit/Write 或 scratchpad 里的 `.py` 文件；Windows 文件名不分大小写（`Transcript.tsx` 和 `transcript.ts` 会撞）；跑完 e2e 用 `git checkout -- studio/screenshots/` 丢掉无意的截图变化；清理 `%TEMP%\amo-studio-test-*`、`amo-studio-e2e-*`。

## 还开着的事

| 事项 | 状态（2026-11-06 核对） |
|---|---|
| 文档整理（Archify 三层） | 11-06 用户审过，合进 master：HANDOFF 瘦身、导航索引 `docs/nav/`（`node scripts/nav.mjs`）+ 锚点测试、plans 只留决定、`plans/later/` 放以后推进的。维护办法和对比实验在 `plans/doc-architecture.md`；以后每批文档改动后用里面的 3 个问题复测 |
| 公司工作台与 Codex 操作（kingkunkun fork） | 11-13 源码包含工作群、Agent 管理、组织架构、给牛马分活（工作列表）、优先级串行自主接活、群内汇报/交接、实际模型选择和可撤回的规范改进，以及 Codex 模型/权限/加号菜单、预览拖动和运行标识。中台工具Agent的当前会话绑定、GPT-6.1 Sol 配置、完整聊天/工具/附件快照已加入本机 `.data/company-bootstrap.json`；高低配与产品的指定档案不进 Git。用户最新已授权构建与重启，桌面编译通过；本轮自身在旧 Host 运行，因此通过独立脚本等待空闲、备份再正式退出，重启状态和任务/会话保留核验看 `.data/restart-after-build.json`。方案 `plans/done/agent-company.md`、`plans/done/agent-work-autonomy.md`。 |
| 本机工具下载 / Android 0.2.3 | 设置 → 工具下载，独立只读服务 `47951`；本机启用 LAN，下载页 `http://172.16.0.56:47951/`、APK `/files/phone-workstudio`。启动恢复开关和清单位于 `.data/tool-downloads/`；临时独立服务在旧 Host 上运行，安全重启脚本切交新版 Host 接管，结果见 `.data/restart-after-build.json`。安卓 0.2.3 / build 7 编译成功，MI 8（b81c6b0f）安装成功；共享代码测试 21 项通过、lint 0 errors / 13 warnings。手机完整下载 SHA-256 与电脑一致（f7091b76…70e31）。备份安装包 `D:\Codex\WorkStudio-builds\WorkStudio-Mobile-0.2.3-20261113-debug.apk`。公司管理页仍是桌面功能，IPA 未构建。见 `plans/done/tool-downloads.md`。 |
| Host 结构 | `plans/host-structure.md`：8a–8c 已合进 master；剩一个 feature 环组 {collab、gitreview、projects、remote、review、sessions、tasks、viewpacks}，拆法写在方案里，没开工。项目梳理总表 `plans/done/cleanup-2026-11.md` |
| 全景（userlayer） | 分支 `studio/panorama`（worktree `G:\PROJECT\AgentMonitorOverlay-panorama`）比 master 多 4 个提交：全景里抽屉打开会话（`plans/userlayer/framework.md` 第 1 步）、内存测量，没合 |
| 远程会话 | 功能都在 master、已发布（`plans/done/remote-session.md`、`plans/done/remote-page-and-new-task.md`；11-06 加了远程任务页的被控端额度）。等用户用两台真电脑验收；会话级授权、模型细到型号、远程权限上限等用户 10-29 定先不做 |
| Android Studio | 工程在 `mobile/`（KMP：`shared` + `app`），调试 APK 在 `mobile/out/`。真实手机和 Tailscale 实网没测（`plans/done/android-studio.md`） |
| iOS Studio | `plans/ios.md`：签名 11-03 通了（jenkins-build 钥匙串），**等 App Store Connect API Key**（打包机 `~/.amo-ios/config` 两个 ID 空着、没有 .p8），之后 validate、问过用户再第一次上传。打包机上 LaunchAgent `com.amo.ios-build` 的残留没卸（等用户点头删 Mac 上的文件） |
| AMO 平台 | 方案 `plans/amo-lan-platform.md`。11-03 的「用完整包更新」还没在用户机器上真点过（11-04 时）。11-06 起清单带更新记录（`history`）；便签、Reviewer、中转要等各自下次发布才有完整历史。展示站统一的更新记录页没做 |
| @ 子会话 | 11-05 合进 master。没验证：真 Claude 开 Fast、真模型会不会照着带 `setup`（`plans/done/subsession-mention-2026-11-05.md`） |
| 等用户点头删的 worktree / 分支 | `G:\PROJECT\AgentMonitorOverlay-devui`（`studio/dev-ui-dir`，已全部合进 master）、`.claude/worktrees/agent-a04ca2f0eeff1a610`（展示页，已合）、`.claude/worktrees/agent-abb445f58543b0e8b`（10-30 的「环境装 Claude Code / Codex」早期版本，多 1 个提交；11-03 master 上另做了一版）。老分支 `codex/chatgpt-binding-name-sync`、`codex/task-launch-entry`、`issue/8` 各多 1 个提交 |
| 以后推进 | 谈过、现在不做的在 `plans/later/`（`README.md` 有清单）：教程第 2、5 章和产品内引导、文件快传、画布工作流，以及几件用户定了以后再说的小事 |

## 已知问题

- `packages/host/src/runtime/codex/server-manager.test.ts` 以前偶发失败：app-server 启动后在后台 `git fetch` OpenAI 的插件市场，这个 git 继承了监听端口，`taskkill /T` 可能漏掉它。11-03 起这个测试用 `-c features.plugins=false` 启动；自动打包时还是把它排除在外（`release.mjs`），等它稳定一阵再定要不要放回去。同一个 git 也会拿着 Electron 的输出管道，让 e2e 的 `app.close()` 等到超时：11-05 起 e2e 的 `launchStudio` 在每个用例的 `codex-home` 写 `[features] plugins = false`。Studio 实际运行时照旧同步插件，碰到端口被占会换个端口重启。
- `packages/host/src/runtime/dsh/dsh-runtime.integration.test.ts` 的「session_start with write in a folder not set up」在全量 vitest 负载下偶尔超时，单独跑能过（11-05、11-06 都见过），原因没查。
- 端到端里 Claude 的 mock 配置没法向 Claude Code 要型号列表（会超时），所以测试模式给 mock 配了内置列表（`packages/host/src/bin.ts`）。
- Studio 里 agent 的命令 PATH 去掉了 WindowsApps，用不到应用商店版的 `pwsh`、`python3`、`winget`（本机 `python`、`node`、`git` 不受影响）。
