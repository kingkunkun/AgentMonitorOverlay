# WorkStudio 手机端

手机上的 WorkStudio 远程客户端。推荐连接电脑内置的独立手机服务，手机账号与团队账号互不影响；也保留原有团队设备协议兼容性。任务、模型调用和命令均在电脑 Host 执行。

## 工程结构（2026-11-02 起）

为了出 iOS 版（`../plans/ios.md`），工程从 `studio/android` 改名为 `studio/mobile`，改成 Kotlin Multiplatform：

- `shared/`：协议、数据层和 Compose 界面（KMP 模块，Compose Multiplatform 1.11.1）。聊天主题、项目列表、新聊天和 # 预设都在 `src/commonMain`，由 Android/iOS 共用；平台适配分别在 `androidMain`、`iosMain`。
- `app/`：Android 外壳，只有 `MainActivity`、Manifest、图标和样式；applicationId、版本号、APK 路径和以前一样。
- `iosApp/`：iOS 外壳，在 Mac 上编译、签名；Windows 的 Android 构建不代表 IPA 已验证。

## 构建

使用 JDK 17、Android SDK API 36 / Build Tools 36.0.0；Gradle Wrapper 固定 9.5.0，AGP 固定 9.3.1。最低支持 Android 9（API 28）。

Windows 在本目录执行：

```powershell
./build.ps1
./build.ps1 -Tasks ':app:assembleDebug', ':app:assembleDebugAndroidTest', ':app:lintDebug'
```

脚本只为本次进程指定 JDK/SDK，低优先级、最多 4 个 worker；优先检查 JAVA_HOME，再使用本机已发现的 Unity JDK。其他机器请设置 JAVA_HOME 和 ANDROID_HOME。也可直接执行 gradlew。local.properties、构建输出和密钥不进入版本控制。

调试 APK：app/build/outputs/apk/debug/app-debug.apk。调试签名用于本次内部验收；正式分发前需要确定长期发布签名，不能把调试密钥作为正式发布密钥。

## 使用

1. 电脑 WorkStudio → 合作模式 → 手机远程：创建独立手机账号，密码 12–128 位。团队账号不用退出。
2. 开启手机远程并允许局域网连接。手机填写电脑显示的 LAN IP:47950，登录刚创建的手机账号。
3. 手机从在线设备列表选择名称带“手机远程”的电脑申请配对。本机创建并启用的同账号手机可自动配对，随后查看和接管本机 WorkStudio 聊天；原生导入记录不共享。
4. 会话内可收发消息、审批、选择全部可用模型/思考强度/权限/Fast、# 提示词和 @ 团队成员。文件外发仍在电脑逐次确认，即使选择完全访问也不免除。
5. 团队账号保持登录并开启 Work中转后，来信建立待回复聊天，仅同步给账号管理中勾选“同步团队来信”的手机账号，不自动运行模型。
6. 在电脑重设密码、停用或删除账号会断开旧登录；关闭手机远程仅停手机连接，团队远程与登录不受影响。账号管理不在手机上开放。

同一可达局域网不需要 Tailscale；没有公网入口时，5G 不能直接连接公司内网电脑。公司 Wi-Fi 隔离和 Windows 防火墙仍可能阻止连接，未自动修改公司网络。详细边界见 [局域网手机说明](../docs/cooperation-privacy-lan.md)。

新版 Android 内部包为 0.2.1 / build 5，应用显示名 WorkStudio，Android/iOS 共用原创头像，来源与提示词见 [图标说明](assets/README.md)。

当前团队服务器是 HTTP；应用为此允许明文连接。需要传输加密时使用 HTTPS/WSS 或覆盖到服务器的 Tailscale 链路。应用不忽略 TLS 证书错误。

## 测试

构建 app 与 androidTest APK 后，可在 mobile 目录使用统一入口（自动安装、运行、保存日志并清除临时测试凭据）：

```powershell
./test.ps1 -FixtureReady '<ready.json路径>'
# 真实模型夹具只运行这一项
./test.ps1 -FixtureReady '<ready.json路径>' -Classes 'RepositoryIntegrationTest'
```

在 studio 目录启动独立夹具，不使用用户正在运行的 Studio 数据：

```powershell
node scripts/android-fixture.mjs
# 或使用团队服务器（会创建独立 android-* 测试账号）
node scripts/android-fixture.mjs --server http://172.16.8.85:47120 --port 47972 --control-port 47973
```

夹具打印 ready.json 路径。密码和 key 保存在相邻的 DPAPI 加密文件中，不输出。通过 android-provision.mjs 将测试密码临时放到模拟器，且为本地服务建立 adb reverse：

```powershell
node scripts/android-provision.mjs <ready.json路径> emulator-5580
adb -s emulator-5580 install -r mobile/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5580 install -r mobile/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5580 shell am instrument -w -e class dev.amo.studio.RepositoryIntegrationTest dev.amo.studio.test/androidx.test.runner.AndroidJUnitRunner
adb -s emulator-5580 shell am instrument -w -e class dev.amo.studio.UiFlowTest,dev.amo.studio.FilePolicyTest,dev.amo.studio.ReliabilityIntegrationTest dev.amo.studio.test/androidx.test.runner.AndroidJUnitRunner
adb -s emulator-5580 shell rm /data/local/tmp/amo-android-test.json
```

UI 测试截图在模拟器 /sdcard/Android/data/dev.amo.studio/files/screenshots，可用 adb pull 保存到 studio/screenshots/android。需要先构建桌面 workspace 包供夹具引用。测试模型默认 mock，夹具的控制端只监听回环地址；结束后 POST 控制端 /shutdown 关闭夹具。

真实 Dxx-DS 验证：夹具加 --real-dxx，从指定开发 Host 的只读 API 识别名称完全匹配的 Dxx-DS 渠道；仅使用该渠道，固定隔离项目和只读权限。每次真实调用先记额度，默认最多 5 次。只运行 RepositoryIntegrationTest；UiFlowTest 和 ReliabilityIntegrationTest 使用 mock 的特定响应，不应用于真实模型夹具。

## 实现和边界

- 网络与协议：StudioRepository.kt；复用 Relay devices 协议和 Host rt.* 命令，认证使用 Bearer header。
- 凭据：Android Keystore AES-GCM；不保存明文密码，备份关闭。
- 历史：按服务器与账号分区的私有缓存（HistoryCache.kt），任务一个文件、每个会话一个文件，后台线程写；每会话最后 3000 项、最多 60 个会话；服务器保留正本。打开会话从缓存的最后一条往后拉，还会变的条目（等审批、在跑、流式中）从最早一条重拉。
- 消息：断线和超时不自动重发；草稿及待确认状态在手机保存，用户核实后可解除等待。
- 查看：20 MiB 文件上限、分块 SHA-256 校验；HTML 内联脚本在不含凭据和原生桥接的 WebView 中运行，禁止网络请求与外部子资源。
- 视觉源：../packages/ui/src/styles/base.css、chat/chat.css、lib/theme.ts；图标几何来自 ../design/icon/tools/studio.svg。字体许可随 APK 存在 assets/licenses。
- 第一版没有手机后台实时推送、附件上传或完整桌面 Markdown 扩展；不运行本地模型与 Focus。
