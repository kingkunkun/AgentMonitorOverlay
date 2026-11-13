import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Modal } from "../lib/Modal.js";

export function SketchDialog({ onAdd, onClose }: { onAdd(file: File): void; onClose(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<number | null>(null);
  const [color, setColor] = useState("#202124");
  const [width, setWidth] = useState(4);
  const [eraser, setEraser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function clear() { const ctx = canvas.current?.getContext("2d"); if (ctx) { ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1024, 640); } }
  useEffect(clear, []);
  function point(e: PointerEvent<HTMLCanvasElement>) { const rect = e.currentTarget.getBoundingClientRect(); return [(e.clientX - rect.left) * 1024 / rect.width, (e.clientY - rect.top) * 640 / rect.height] as const; }
  function start(e: PointerEvent<HTMLCanvasElement>) {
    if (busy || e.button !== 0 || drawing.current !== null) return;
    const ctx = e.currentTarget.getContext("2d"); if (!ctx) return;
    drawing.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId);
    ctx.strokeStyle = eraser ? "white" : color; ctx.lineWidth = eraser ? width * 5 : width; ctx.lineCap = "round"; ctx.lineJoin = "round";
    const [x, y] = point(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + .01, y); ctx.stroke();
  }
  function move(e: PointerEvent<HTMLCanvasElement>) { if (drawing.current !== e.pointerId) return; const ctx = e.currentTarget.getContext("2d"); if (ctx) { ctx.lineTo(...point(e)); ctx.stroke(); } }
  function stop(e: PointerEvent<HTMLCanvasElement>) { if (drawing.current === e.pointerId) drawing.current = null; }
  return <Modal portal label="绘制草图" className="sketch-dialog" onClose={onClose} busy={busy}>
    <h3>绘制草图</h3>
    <div className="settings-row"><label>颜色 <input type="color" value={color} onChange={(e) => { setColor(e.target.value); setEraser(false); }} /></label><label>笔宽 <input aria-label="笔宽" type="range" min="1" max="18" value={width} onChange={(e) => setWidth(Number(e.target.value))} /></label><button className="btn-ghost" aria-pressed={eraser} onClick={() => setEraser(!eraser)}>{eraser ? "使用画笔" : "橡皮擦"}</button><button className="btn-ghost" onClick={clear}>清空</button></div>
    <canvas ref={canvas} width={1024} height={640} aria-label="草图画布" onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} />
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="settings-row end"><button className="btn-ghost" disabled={busy} onClick={onClose}>取消</button><button className="btn-primary" disabled={busy} onClick={() => { setBusy(true); canvas.current?.toBlob((blob) => { if (!blob) { setError("草图导出失败，请重试"); setBusy(false); return; } onAdd(new File([blob], `sketch-${Date.now()}.png`, { type: "image/png" })); onClose(); }, "image/png"); }}>添加到聊天</button></div>
  </Modal>;
}
