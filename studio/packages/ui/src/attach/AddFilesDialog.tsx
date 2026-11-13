import { useRef, useState } from "react";
import { Modal } from "../lib/Modal.js";
import { pickDirectory } from "../folders/FolderPicker.js";
import type { AttachmentsState } from "./useAttachments.js";

export function AddFilesDialog({ attach, onFind, onClose }: { attach: AttachmentsState; onFind(): void; onClose(): void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const folderAvailable = !!(window.amo?.folders || window.amo?.pickDirectory);
  return <Modal portal label="文件和文件夹" className="codex-goal-dialog" busy={busy} onClose={onClose}>
    <h3>文件和文件夹</h3>
    <button className="btn-ghost" onClick={() => picker.current?.click()}>选择图片或文件…</button>
    <input ref={picker} type="file" hidden multiple onChange={(e) => { const files = [...(e.currentTarget.files ?? [])]; if (files.length) { attach.addDropped(files); onClose(); } }} />
    <button className="btn-ghost" disabled={busy || !folderAvailable} title={folderAvailable ? undefined : "文件夹选择需要桌面端"} onClick={async () => { setBusy(true); try { const path = await pickDirectory(); if (path) { attach.addFiles([path]); onClose(); } } catch (err) { setError(String(err)); } finally { setBusy(false); } }}>选择文件夹…</button>
    <button className="btn-ghost" onClick={() => { onClose(); onFind(); }}>查找项目内的文件…</button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </Modal>;
}
