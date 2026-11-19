import { useState } from "react";
import { TASK_DESCRIPTION_MAX, type Task } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";

// A task's description (2026-10-17, stage 16): what it is about, shown on its canvas card and task page. Written here,
// from the canvas's right-click menu or the task page, or by an agent (MCP task_describe).

export function DescriptionDialog({ link, task, readOnly = false, onClose }: { link: HostLink; task: Task; readOnly?: boolean; onClose(): void }) {
  const [text, setText] = useState(task.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await call(link, "PATCH /api/tasks/:id", { id: task.id }, { description: text });
      onClose();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal className="description-dialog" label="任务说明" testId="description-dialog" onClose={onClose}>
      <span className="modal-title">任务说明 · {task.title || "未命名任务"}</span>
      <textarea
        className="side-textarea"
        aria-label="说明内容"
        value={text}
        readOnly={readOnly}
        rows={7}
        maxLength={TASK_DESCRIPTION_MAX}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <div className="description-dialog-actions">
        {!readOnly && <span className="settings-hint">Ctrl+Enter 保存{text.trim() ? "" : "；留空即删除说明"}</span>}
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={onClose}>
          {readOnly ? "关闭" : "取消"}
        </button>
        {!readOnly && <button type="button" className="btn-primary" disabled={busy || text.trim() === (task.description ?? "")} onClick={() => void save()} data-testid="description-save">
          保存
        </button>}
      </div>
    </Modal>
  );
}
