# Work中转与 WorkStudio

Work中转是团队通信窗口：私聊、AI 问询与回复回流、附件、批注和处理状态。它与远程使用相同的团队服务器和平台账号，但不需要打开远程，不会自动配对、授权或共享本地任务聊天。

WorkStudio 顶栏的“Work中转”直接打开配套窗口。集成包用同一个 WorkStudio.exe 的 `--amo-app=relay` 入口运行；源码开发版使用 `release/local-relay/AMO Relay/AMO Relay.exe`。内部包名、协议、数据库和旧目录保留兼容，界面、窗口和托盘名称为 Work中转。

集成版界面来自本机编译，随 WorkStudio 更新，不下载或自动执行服务器的客户端界面。服务器只提供账号、聊天、附件、状态和设备转发等接口；消息内容仍会传给并存储在所连接的团队服务器。源码运行/未带本地 client 的旧独立客户端仍保留上游热更新行为。

原 WorkStudio 的 `.data`、中转的 `%APPDATA%/AMO Relay`、平台账号的 `%APPDATA%/AMO` 均不迁移、不删除。若没有平台账号，中转会提示先登录平台。打开中转不代表允许远程设备操作；关闭远程也不会关闭中转聊天。

## 本机编译

在 studio 下依次运行（打包产物只写 release，不部署团队服务器）：

```powershell
npm run build
node scripts/relay-release.mjs --out release/relay-local
node scripts/package-portable.mjs release/local-relay --platform --only relay --bundled-relay
node scripts/package-portable.mjs release/workstudio-integrated --platform --only studio --bundled-relay
```

单独启动本机中转：`start-work-relay.cmd`。集成包位于 `release/workstudio-integrated/WorkStudio`；继续使用原开发版时，关闭工作台外壳再运行 `start-studio.cmd`，新的 preload/入口才会加载。不要在有任务运行时完全退出 Host。

打包检查对 `client/amo-relay.mjs` 的两条 types/index 例外来自生成文件中 URI 库的 JSDoc `import()` 类型注释，不是运行时缺失依赖；未放宽其他模块检查。

验证：typecheck/build；中转相关单元测试 20 项通过；新增顶栏入口 E2E、集成包本地界面/平台登录 E2E、中转双账号两轮问询/回复/附件 E2E 均通过，截图为 `screenshots/studio/relay-entry.png` 与 `screenshots/relay/work-bundled.png`。原 `studio/teamrelay.spec.ts` 的模拟 Claude 发问场景未产生 pending 请求，60 秒超时，本次不把它算作通过；相关 Host 中转单测正常。验证使用隔离账号/服务，没有向真实团队成员发送测试消息。
