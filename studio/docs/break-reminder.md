# 活动提醒与旧桌宠（2026-11-12）

用户要求关闭原先的 Focus 桌宠和“等太久就生气乱飞”；随后要求独立增加每 15 分钟的活动提醒，使用其提供的图片。这两个行为分开实现。

- Focus 保留运行/审批/待处理列表，移除皮肤选择、预览、桌宠和动作测试。旧 `amo:bot-fly` IPC 保留兼容空实现，旧渲染器也不能重新打开飞行桌宠。
- 新活动提醒随 WorkStudio 桌面外壳启动，默认开启；每 15 分钟显示“站起来，活动下！”。图片按显示器工作区 50% 高度展示，跨屏内移动，30 秒自动收起。首次提醒在外壳启动约 15 分钟后。
- 设置 → 界面 → 活动提醒：开关、预览提醒、收起提醒。关闭会取消计时并立即关闭当前提醒；开关写入数据目录的 `shell-prefs.json`，重启保留。重新开启从 15 分钟重新计时。
- 提醒使用主工作台所在显示器；透明、置顶、不获取焦点，整窗鼠标穿透，不转发鼠标事件。系统选择减少动态效果时静态展示。
- 图片在 `packages/app/assets/break-reminder.png`，直接来自用户上传。HTML 使用本地内嵌图片和 CSS，无 preload、网络、脚本、键鼠/剪贴板读取或 idle 监控。时间间隔与“用户多久没操作”无关。

实现入口：`packages/app/src/break-reminder.ts`；外壳在 `main.ts` 管理计时和本机界面 IPC，设置在 `settings/SettingsDialog.tsx`。关闭主窗口到托盘不退出外壳，提醒继续；完全退出后停止。

验证：计时/自动收起/禁用单元测试，Focus 长时间等待与旧飞行 IPC 的拒绝、设置持久化、半屏图片和不抢焦点的 Electron 隔离端到端测试。截图在 `screenshots/studio/activity-reminder.png`、`settings-without-desktop-pets.png`、`focus-without-desktop-pets.png`。实机仅重载桌面外壳，原 Host PID 与聊天数量保持。
