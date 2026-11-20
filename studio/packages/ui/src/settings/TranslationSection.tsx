import { useEffect, useState } from "react";
import { DEFAULT_TRANSLATION_MODEL, isTranslationModel, TRANSLATION_PROFILE } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useProfileChoices } from "../lib/choices.js";

export function TranslationSection({ link }: { link: HostLink }) {
  const { choices, error: loadError } = useProfileChoices(link, TRANSLATION_PROFILE);
  const [model, setModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void call(link, "GET /api/settings/translation").then(s => { if (live) setModel(s.model); }, e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [link]);
  const models = choices?.models.filter(m => isTranslationModel(m.id)) ?? [];
  const missing = model !== null && !models.some(m => m.id === model);
  const save = async (next: string) => {
    setSaving(true); setError("");
    try { setModel((await call(link, "PUT /api/settings/translation", {}, { model: next })).model); }
    catch (e) { setError(e instanceof Error ? e.message : "未能保存翻译模型"); }
    finally { setSaving(false); }
  };
  return <section className="settings-section">
    <h3>聊天翻译</h3>
    <p className="settings-hint">翻译草稿和所选文字时使用这个模型。不会改变聊天使用的模型。</p>
    <label>默认翻译模型　<select className="field" aria-label="默认翻译模型" disabled={saving || !model || !models.length} value={model ?? ""} onChange={e => void save(e.target.value)}>
      {model === null && <option value="">正在读取…</option>}
      {missing && <option value={model!}>{model}{choices ? "（当前不可用）" : ""}</option>}
      {models.map(m => <option key={m.id} value={m.id}>{m.label} · {m.id}</option>)}
    </select></label>
    <p className="settings-hint">默认：GPT-6.2 Sol（{DEFAULT_TRANSLATION_MODEL}）。仅列出 GPT 渠道的模型。</p>
    {(error || loadError || (choices && !models.length)) && <p className="form-error" role="alert">{error || loadError || "当前渠道没有可用的 GPT 翻译模型。"}</p>}
  </section>;
}
