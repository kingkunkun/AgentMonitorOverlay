import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CompanyArchive, CompanyBootstrap } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";

export function readCompanyBootstrap(storePath: string): { input: CompanyBootstrap; digest: string; root: string } | null {
  if (storePath === ":memory:") return null;
  const file = join(dirname(storePath), "company-bootstrap.json");
  if (!existsSync(file)) return null;
  if (statSync(file).size > 512_000) throw new HostError("bad_request", "公司初始化文件过大");
  const text = readFileSync(file, "utf8");
  const input = JSON.parse(text) as CompanyBootstrap;
  if (input?.version !== 1 || !Array.isArray(input.agents) || input.agents.length > 100) throw new HostError("bad_request", "公司初始化文件格式无效");
  return { input, digest: createHash("sha256").update(text).digest("hex"), root: join(dirname(storePath), "company-archives") };
}

function inside(root: string, value: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new HostError("bad_request", "历史资料必须使用本机归档目录内的绝对路径");
  const dir = realpathSync(root);
  const expectedRoot = join(realpathSync(dirname(root)), basename(root));
  if (dir.toLowerCase() !== expectedRoot.toLowerCase()) throw new HostError("read_only", "company-archives 目录不能通过链接指向其他位置");
  const file = realpathSync(resolve(value));
  const rel = relative(dir, file);
  if (!rel || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) throw new HostError("read_only", "历史资料路径越出 company-archives 目录");
  if (!statSync(file).isFile()) throw new HostError("bad_request", "历史资料必须是普通文件");
  return file;
}

/** Only explicit handoff manifests are read. Real paths defeat symlink/junction escapes; transcript bytes must match. */
export function validateCompanyArchive(root: string, input: CompanyArchive): CompanyArchive {
  if (!input || typeof input.id !== "string" || !input.id || typeof input.title !== "string" || !input.title || !["workstudio", "codex"].includes(input.source) || input.localOnly !== true || !Number.isSafeInteger(input.messageCount) || input.messageCount < 0 || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new HostError("bad_request", "历史资料信息无效");
  const manifestPath = inside(root, input.manifestPath);
  if (statSync(manifestPath).size > 64_000) throw new HostError("bad_request", "历史资料清单过大");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  for (const key of ["id", "title", "source", "messageCount", "sha256", "localOnly", "transcriptPath"] as const) if (manifest[key] !== input[key]) throw new HostError("bad_request", `历史资料清单与初始化记录不一致：${key}`);
  if (manifest.version !== 1 || manifest.kind !== "workstudio-company-archive") throw new HostError("bad_request", "不是已授权的公司历史资料清单");
  const transcriptPath = inside(root, input.transcriptPath);
  if (statSync(transcriptPath).size > 512_000_000) throw new HostError("bad_request", "历史资料超过单文件大小限制");
  const hash = createHash("sha256"), fd = openSync(transcriptPath, "r"), buffer = Buffer.allocUnsafe(64 * 1024);
  try { let n: number; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n)); } finally { closeSync(fd); }
  if (hash.digest("hex") !== input.sha256) throw new HostError("bad_request", "历史资料校验失败，原始内容可能已经变化");
  return { id: input.id, title: input.title, source: input.source, messageCount: input.messageCount, sha256: input.sha256, manifestPath, transcriptPath, localOnly: true };
}
