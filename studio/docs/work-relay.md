# Work中转与 WorkStudio

Work中转是团队通信窗口：私聊、AI 问询与回复回流、附件、批注和处理状态。它与远程使用相同的团队服务器和平台账号，但不需要打开远程，不会自动配对、授权或共享本地任务聊天。

WorkStudio 顶栏的“合作模式”包含中转独立开关与“打开中转窗口”。集成包和源码开发版均使用 `release/workstudio-integrated/WorkStudio/WorkStudio.exe --amo-app=relay`；不再使用旧独立中转安装。内部包名、协议、数据库和旧目录保留兼容，界面、窗口和托盘名称为 Work中转。

集成版界面来自本机编译，随 WorkStudio 更新，不下载或自动执行服务器的客户端界面。服务器只提供账号、聊天、附件、状态和设备转发等接口；消息内容仍会传给并存储在所连接的团队服务器。源码运行/未带本地 client 的旧独立客户端仍保留上游热更新行为。

原 WorkStudio 的 `.data`、中转的 `%APPDATA%/AMO Relay`、平台账号的 `%APPDATA%/AMO` 均保留。可以直接在 WorkStudio 合作模式登录/注册，复用平台账号存储。打开中转不代表允许远程设备操作；关闭远程也不会关闭中转聊天。中转按钮明确区分收起窗口与关闭功能，关闭后重启保持。合作模式、局域网手机连接和隐私边界详见 [cooperation-privacy-lan.md](cooperation-privacy-lan.md)。

## 本机编译

在 studio 下依次运行（打包产物只写 release，不部署团队服务器）：

```powershell
npm run build
node scripts/relay-release.mjs --out release/relay-local
node scripts/package-portable.mjs release/workstudio-integrated --platform --only studio --bundled-relay
```

单独启动本机中转：`start-work-relay.cmd`。集成包位于 `release/workstudio-integrated/WorkStudio`；继续使用原开发版时，关闭工作台外壳再运行 `start-studio.cmd`，新的 preload/入口才会加载。不要在有任务运行时完全退出 Host。

打包检查对 `client/amo-relay.mjs` 的两条 types/index 例外来自生成文件中 URI 库的 JSDoc `import()` 类型注释，不是运行时缺失依赖；未放宽其他模块检查。

验证使用隔离账号/服务，没有向真实团队成员发送测试消息。合作模式、独立中转开关、打包入口及本地界面 E2E 截图在 `screenshots/studio/cooperation-controls.png`、`screenshots/studio/build-job.png`、`screenshots/relay/work-bundled.png`。
