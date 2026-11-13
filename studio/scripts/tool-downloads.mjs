// Publish locally; never contacts the team release server or exposes arbitrary paths.
import { mkdir, readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const [command, dataArg, apkArg] = process.argv.slice(2);
if (!dataArg || !["publish", "serve"].includes(command)) throw new Error("Usage: node scripts/tool-downloads.mjs publish|serve <dataDir> [apk]");
const root = join(resolve(dataArg), "tool-downloads");
if (command === "serve") {
  const { ToolDownloadServer } = await import("../packages/host/dist/features/downloads/server.js");
  const server = new ToolDownloadServer(root);
  await server.catalog();
  await server.start(true);
  console.log(JSON.stringify({ pid: process.pid, urls: server.urls() }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void server.close().then(() => process.exit(0)));
} else {
  if (!apkArg) throw new Error("APK required");
  const gradle = await readFile(new URL("../mobile/app/build.gradle.kts", import.meta.url), "utf8");
  const version = /versionName\s*=\s*"([\d.]+)"/.exec(gradle)?.[1];
  const versionCode = Number(/versionCode\s*=\s*(\d+)/.exec(gradle)?.[1]);
  if (!version || !versionCode) throw new Error("Android version missing");
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(resolve(apkArg))) { hash.update(chunk); bytes += chunk.length; }
  const sha256 = hash.digest("hex");
  const files = join(root, "files"); await mkdir(files, { recursive: true });
  const target = join(files, `${sha256}.apk`);
  await copyFile(resolve(apkArg), `${target}.tmp`); await rename(`${target}.tmp`, target);
  const item = { id: "phone-workstudio", title: "手机工作台", version, versionCode, filename: `WorkStudio-Mobile-${version}.apk`, bytes, sha256, publishedAt: new Date().toISOString(), notes: "手机聊天支持模型、权限选择和任务运行状态。覆盖安装保留账号与草稿。首次连接使用电脑手机服务中的地址和手机账号。Android 9 及以上。" };
  await writeFile(join(root, "catalog.json.tmp"), JSON.stringify([item], null, 2));
  await rename(join(root, "catalog.json.tmp"), join(root, "catalog.json"));
  console.log(JSON.stringify(item, null, 2));
}
