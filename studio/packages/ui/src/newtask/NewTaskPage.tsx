import { useEffect, useRef, useState } from "react";
import { BackButton } from "../shell/BackButton.js";
import type { ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import type { Scope } from "../board/Board.js";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { activeModel, sameOptions, useProfileChoices, useChoicesFor } from "../lib/choices.js";
import { samePick } from "../lib/recents.js";
import { pickFolder, shortModel, pickable } from "../lib/profiles.js";
import { StartingCover } from "../lib/StartingCover.js";
import { useSettings } from "../settings/useSettings.js";
import { nextEffort, pickLabel } from "../chat/pickers.js";
import { FastUsageHint } from "../chat/FastUsageHint.js";
import { ComposerModelPicker } from "../chat/ComposerModelPicker.js";
import { PermissionPicker } from "../chat/PermissionPicker.js";
import { SketchDialog } from "../chat/SketchDialog.js";
import { AddFilesDialog } from "../attach/AddFilesDialog.js";
import { DSH_FULL_ACCESS, SandboxHint } from "../settings/SandboxHint.js";
import { draftText, submitDraft, useTaskDraft } from "./draft.js";
import { ModelRow, tilePicks } from "./ModelRow.js";
import { ChoicePicker } from "./ChoiceRow.js";
import { useDraftChoices } from "./useDraftChoices.js";
import { MentionList, useComposerMentions } from "../attach/useMentions.js";
import { FileSelector } from "../attach/FileSelector.js";
import { PromptTemplateDialog } from "../attach/PromptTemplateDialog.js";
import { HashPresetButton } from "../attach/HashPresets.js";
import { SubSessionDialog } from "../attach/SubSessionDialog.js";
import { subSessionSetups } from "../attach/mentions.js";
import { useAttachments } from "../attach/useAttachments.js";
import { AttachTray } from "../attach/AttachTray.js";
import { IconPaperclip } from "../attach/icons.js";
import { withFileRefs } from "../attach/refs.js";
import { useRemote } from "../remote/remote.js";
import { RemoteDraft } from "./RemoteDraft.js";
import { remoteModeShown } from "./remoteTargets.js";
import { ResumePicker, SOURCE_LABEL } from "./ResumePicker.js";
import { relativeTime } from "../lib/status.js";
import type { OutsideSession } from "@amo-studio/protocol";

/** 接续已有会话 runs on this profile only: the outside sessions are the local Claude Code login's. */
const CLAUDE_SUBSCRIPTION = "claude-subscription";

/** The same folder, case and slashes aside (Windows paths as the Host gives them). */
const sameDir = (a: string, b: string) => a.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() === b.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

interface NewTaskPageProps {
  link: HostLink;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  tasks: readonly Task[];
  /** Sessions @ lists under their tasks. */
  sessions?: readonly Session[];
  profiles: readonly ModelProfile[];
  /** Where the page was opened from: preselects the project or the topic of a fresh draft. */
  scope: Scope;
  /** Opened from this topic's canvas: a task created in that topic always goes on it (S11-A). */
  canvasTopicId?: string;
  /** What "←" says: where it returns (看板 or 画布). */
  backLabel?: string;
  onBack(): void;
  /** `session` null: the task was only filed (放进待办). */
  onCreated(task: Task, session: Session | null): void;
  /** 远程创建 (2026-10-29): opened in 「在别的设备上」 with this device picked (the remote page's 「在它上面新建任务」). */
  remoteDevice?: { account: string; device: string };
  /** A task created on another device: its copy here, once it has come. */
  onOpenRemote?(taskId: string, sessionId: string | null): void;
}

/**
 * 草稿任务页 (design/ui-directions/new-task.html): no dialog, the main area becomes an empty task. Projects and topics are
 * rows of chips (both may stay unpicked: no project runs in the common folder), the model is a tile, the effort a set
 * of bars, the permissions a segmented control. Enter starts, Ctrl+Enter files the task in 待办. The draft is kept.
 */
export function NewTaskPage({ link, workspaces, topics, tasks, sessions = [], profiles, scope, canvasTopicId, backLabel = "看板", onBack, onCreated, remoteDevice, onOpenRemote }: NewTaskPageProps) {
  const { draft, update, reset } = useTaskDraft(profiles);
  // 「在这台电脑上 | 在别的设备上」 (4.1): shown with remote on, logged in, and a device that allowed this computer.
  const remote = useRemote(link);
  const [side, setSide] = useState<"here" | "remote">(remoteDevice ? "remote" : "here");
  const remoteShown = remoteModeShown(remote);
  const remoteMode = remoteShown && side === "remote" && !!remote;
  const rows = useDraftChoices({ draft, update, workspaces, topics, tasks });
  const projects = rows.projects;
  const [drawer, setDrawer] = useState(false);
  const [modelPopup, setModelPopup] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [addingFiles, setAddingFiles] = useState(false);
  const [sketching, setSketching] = useState(false);
  const addBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addMenu) return;
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === "Escape" : !addBox.current?.contains(e.target as Node)) setAddMenu(false); };
    window.addEventListener("mousedown", close); window.addEventListener("keydown", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", close); };
  }, [addMenu]);
  const draftProfiles = pickable(profiles, draft.pick.profileId);
  const draftChoices = useChoicesFor(link, modelPopup ? draftProfiles.map((p) => p.id) : []);
  const [projectPicker, setProjectPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  // 正在启动: the page is covered while the first session starts (filing in 待办 is quick).
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState("");
  // "显示在画布上" for a task in a topic: off unless the page was opened from that topic's canvas (then always on).
  const [showOnCanvas, setShowOnCanvas] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  // Images and files pasted, dropped or picked go with the first sentence (2026-10-19); they are not kept in the draft.
  const attach = useAttachments(link);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const settings = useSettings(link);
  const presets = settings?.presets ?? [];
  const { choices } = useProfileChoices(link, draft.pick.profileId);
  const model = choices ? activeModel(choices, draft.pick.model ? { model: draft.pick.model } : {}) : undefined;
  // 接续已有会话 (2026-11-05): the outside session picked; not kept in the draft (it may be taken on elsewhere meanwhile).
  const [resume, setResume] = useState<OutsideSession | null>(null);
  const [pickingResume, setPickingResume] = useState(false);
  const subscription = profiles.find((p) => p.id === CLAUDE_SUBSCRIPTION && !p.hidden && !p.unavailable);

  // A fresh draft starts where the page was opened from (in a topic, with its one preferred project); a draft with text
  // keeps its own choices.
  useEffect(() => {
    if (!draft.text.trim()) {
      const projectId = scope.kind === "workspace" ? scope.id : null;
      update({ projectId, ...rows.topicPatch(scope.kind === "topic" ? scope.id : null, projectId) });
    }
    input.current?.focus();
    // Only when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const topic = rows.topic;
  const fromCanvas = !!topic && topic.id === canvasTopicId;
  const onCanvas = !!topic && (fromCanvas || showOnCanvas);
  // 找文件 from the @ list: the picked project's files.
  const [finding, setFinding] = useState<{ query: string } | null>(null);

  // @ refers to a project, a task or one of its sessions, or (once a project is picked) a file, as in a session's
  // composer (2026-10-29); it never sets the task's own project or topic.
  const mentions = useComposerMentions({
    link,
    text: draft.text,
    setText: (text) => update({ text }),
    tasks,
    sessions,
    current: null,
    projects,
    projectsAlways: true,
    workspaceId: draft.projectId,
    picks: { value: new Map(Object.entries(draft.refs ?? {})), set: (next) => update({ refs: Object.fromEntries(next) }) },
    onFile: (path) => attach.addFiles([path]),
    onFind: (query) => setFinding({ query }),
    onMark: (ref) => attach.addRefs([ref]),
    // 2026-11-05: the task's first session may start sub-sessions, so 开子会话… is offered here too.
    subsession: true,
  });

  const where = `${draft.projectId ? `在 ${projects.find((w) => w.id === draft.projectId)?.name ?? "?"} 里运行` : "不指定项目：在公共目录里运行"}${topic ? ` · 放进「${topic.title}」` : ""}`;

  async function submit(file: boolean) {
    if (busy) return;
    if (resume && file) return setError("接续的会话不能放进待办：直接点「接续」，第一句话可以不写。");
    if (resume && draft.pick.profileId !== CLAUDE_SUBSCRIPTION) return setError("接续已有会话只能用 Claude 订阅：先在下面选回它。");
    if (!resume && !draft.text.trim()) return setError(file ? "写一句话再放进待办。" : "写一句话再开始。");
    if (!file && !draft.pick.profileId) return setError("先选一个模型。");
    if (file && !attach.empty) return setError("放进待办不带图片和文件：先移除它们，或者直接开始。");
    // A 子会话设定 lives with the session it is sent to: a filed task has none yet (2026-11-05).
    if (file && Object.entries(draft.refs ?? {}).some(([name, r]) => r.kind === "subsession" && draft.text.includes(`@${name}`))) return setError("放进待办不带子会话设定：直接开始，或者先去掉 @子会话。");
    if (attach.uploading) return setError("图片还在上传，稍等一下。");
    if (attach.failed) return setError("有图片上传失败，移除后再开始。");
    setBusy(true);
    if (!file) setStarting(resume ? "正在接续会话…" : `正在启动 ${shortModel(profiles.find((p) => p.id === draft.pick.profileId))}…`);
    setError("");
    try {
      const text = withFileRefs(draftText(draft), attach.files.map(attach.refOf));
      const images = attach.images.flatMap((i) => (i.id ? [i.id] : []));
      const setups = draft.refs ? subSessionSetups(draft.text, new Map(Object.entries(draft.refs))) : [];
      const { refs: _refs, ...rest } = draft;
      const created = await submitDraft(link, { ...rest, title: "", lead: false, text, ...(resume && !rest.title.trim() ? { title: resume.title } : {}) }, file, onCanvas, images, resume?.id, setups);
      setResume(null);
      attach.reset();
      reset({ projectId: draft.projectId, topicId: draft.topicId });
      onCreated(created.task, created.session);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
      setStarting(null);
    }
  }

  /** A session picked in 接续已有会话: the task's name and project from it, the Claude subscription as the model. */
  function pickResume(s: OutsideSession) {
    setPickingResume(false);
    setResume(s);
    setError("");
    update({ title: s.title.slice(0, 100), ...(subscription ? { pick: { profileId: subscription.id, model: null } } : {}) });
    if (s.workspaceId) rows.pickProject(s.workspaceId);
    requestAnimationFrame(() => input.current?.focus());
  }

  async function addProject(path?: string) {
    const dir = path ?? (await pickFolder());
    if (!dir) return;
    try {
      const ws = await call(link, "POST /api/workspaces", {}, { path: dir });
      rows.pickProject(ws.id);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    }
  }

  // Alt 1–6: the 常用 tiles; Alt E: one effort up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not in 「在别的设备上」: its models are the other computer's.
      if (!e.altKey || e.ctrlKey || remoteMode) return;
      if (/^[1-6]$/.test(e.key)) {
        const t = tilePicks(profiles, draft.pick)[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          update({ pick: t });
        }
      } else if (e.key.toLowerCase() === "e" && model) {
        e.preventDefault();
        const next = nextEffort(model.efforts, draft.options.effort ?? model.defaultEffort);
        if (next) update({ options: { ...draft.options, effort: next } });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profiles, draft, model, update, remoteMode]);

  return (
    <section className="draft-page" aria-label="新聊天">
      <div className="page-head">
        <BackButton label={backLabel} onClick={onBack} />
        <span className="page-crumb">/ 新聊天</span>
        <span className="spacer" />
        <span className="page-crumb">草稿自动保存，离开也不会丢</span>
      </div>
      <div className="draft-wrap">
        <div className="draft">
          <div className="draft-ask-row">
            <h1 className="draft-ask">今天想做些什么？</h1>
            {false && !remoteMode && subscription && (
              <button type="button" className="btn-ghost small draft-resume-btn" onClick={() => setPickingResume(true)} title="把终端或 Claude 桌面版里开的 Claude 会话接过来，在这里接着做" data-testid="draft-resume-open">
                接续已有会话…
              </button>
            )}
            {remoteShown && (
              <span className="perm draft-side" role="group" aria-label="在哪台电脑上" data-testid="draft-side">
                <button type="button" aria-pressed={!remoteMode} onClick={() => setSide("here")}>
                  在这台电脑上
                </button>
                <button type="button" aria-pressed={remoteMode} onClick={() => setSide("remote")} data-testid="draft-side-remote">
                  在别的设备上
                </button>
              </span>
            )}
          </div>
          <p className="draft-lede">
            {remoteMode ? "任务建在你的另一台电脑上，会话在那边跑、用那边的模型账号；能选什么、要不要那边点同意，由它的「远程设置」定。" : "写下第一句话就能开始。项目、模型和思考强度都在下面，点一下就换。"}
          </p>

          {remoteMode ? (
            <RemoteDraft
              link={link}
              remote={remote}
              {...(remoteDevice ? { initialDevice: remoteDevice } : {})}
              tasks={tasks}
              draft={draft}
              update={update}
              onDone={() => reset({ projectId: draft.projectId, topicId: draft.topicId })}
              onOpenTask={(taskId, sessionId) => onOpenRemote?.(taskId, sessionId)}
            />
          ) : (
          <>
          <div className="draft-where"><div className="draft-project-control">
            <button type="button" className="compact-choice" aria-label="选择项目" aria-haspopup="dialog" onClick={() => setProjectPicker(true)}>⌑ {projects.find((w) => w.id === draft.projectId)?.name ?? "选择项目"} <span>⌄</span></button>
            <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void addProject()}>+ 添加项目</button>
          </div></div>

          {resume && (
            <div className="draft-resume" data-testid="draft-resume">
              <div className="draft-resume-head">
                <span className="pick-lab">接续</span>
                <span className="draft-resume-title">{resume.title}</span>
                <span className="draft-resume-sub">
                  {SOURCE_LABEL[resume.source]} · {relativeTime(resume.lastModified)}
                </span>
                <button type="button" className="link-btn" onClick={() => setPickingResume(true)}>
                  换一个
                </button>
                <button type="button" className="link-btn" onClick={() => setResume(null)} data-testid="draft-resume-clear">
                  不接续了
                </button>
              </div>
              {(() => {
                const project = projects.find((w) => w.id === draft.projectId);
                if (project && sameDir(project.path, resume.cwd)) return null;
                return (
                  <span className="draft-resume-note" data-testid="draft-resume-where">
                    原来在 <code>{resume.cwd}</code> 里工作，接过来后在{project ? <>项目目录 <code>{project.path}</code></> : "公共目录"}里继续。
                    {!resume.workspaceId && (
                      <>
                        {" "}
                        <button type="button" className="link-btn" onClick={() => void addProject(resume.cwd)} data-testid="draft-resume-add-project">
                          把原目录添加为项目
                        </button>
                      </>
                    )}
                  </span>
                );
              })()}
              <span className="draft-resume-note">接过来的是一份副本，原会话不动。第一句话可以不写：不写就只接过来，等你发消息。</span>
            </div>
          )}

          <div
            className={dragging ? "draft-composer dropping" : "draft-composer"}
            onDragOver={(e) => {
              if (attach.onDragOver(e)) setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(e) => {
              setDragging(false);
              attach.onDrop(e);
            }}
          >
            <AttachTray attach={attach} />
            <textarea
              ref={input}
              value={draft.text}
              rows={3}
              aria-label="第一句话"
              placeholder="向 WorkStudio 提问，输入 # 使用预设任务，@ 引用项目或文件"
              onChange={(e) => {
                update({ text: e.target.value });
                mentions.track(e.target);
              }}
              onSelect={(e) => mentions.track(e.currentTarget)}
              onPaste={attach.onPaste}
              onKeyDown={(e) => {
                if (mentions.onKeyDown(e)) return;
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit(e.ctrlKey || e.metaKey);
                }
              }}
            />
            <MentionList mentions={mentions} />
            <div className="cbar">
              <div className="draft-add-tools" ref={addBox}>
                <button type="button" className="composer-tools-trigger" aria-label="添加" aria-expanded={addMenu} disabled={busy} onClick={() => setAddMenu(!addMenu)}>+</button>
                {addMenu && <div className="composer-popover composer-add-menu" role="dialog" aria-label="添加"><div className="composer-popover-heading">添加</div>
                  <button type="button" onClick={() => { setAddMenu(false); setAddingFiles(true); }}>文件和文件夹</button>
                  {profiles.find((p) => p.id === draft.pick.profileId)?.runtime === "codex" && <button type="button" aria-pressed={draft.options.plan ?? false} onClick={() => { update({ options: { ...draft.options, plan: !draft.options.plan } }); setAddMenu(false); }}>计划模式 <small>{draft.options.plan ? "已开启" : "开启计划模式"}</small></button>}
                  <button type="button" onClick={() => { setAddMenu(false); setSketching(true); }}>绘图 <small>绘制草图</small></button>
                </div>}
              </div>
              {draft.options.plan && profiles.find((p) => p.id === draft.pick.profileId)?.runtime === "codex" && <span className="composer-mode-badge">计划模式</span>}
              <HashPresetButton link={link} onPick={(text) => update({ text: `${text}${draft.text.trim() ? `\n\n${draft.text}` : ""}` })} />
              <button type="button" className="round-btn attach" aria-label="添加图片或文件" title="添加图片或文件（也可以粘贴或拖进来）" onClick={() => picker.current?.click()}>
                <IconPaperclip />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                data-testid="draft-attach-input"
                onChange={(e) => {
                  attach.addDropped([...(e.currentTarget.files ?? [])]);
                  e.currentTarget.value = "";
                }}
              />
              {choices && <PermissionPicker permissions={choices.permissions} value={draft.options.permission ?? choices.defaultPermission} disabled={busy} onPick={(permission) => update({ options: { ...draft.options, permission } })} />}
              <span className="composer-options-spacer" />
              <ComposerModelPicker profileId={draft.pick.profileId} groups={draftProfiles.map((p) => ({ profileId: p.id, label: p.label, models: (p.id === draft.pick.profileId ? choices : draftChoices.get(p.id))?.models ?? [], loading: p.id !== draft.pick.profileId && !draftChoices.has(p.id) }))} onProfileModel={(profileId, id) => { const m = (profileId === draft.pick.profileId ? choices : draftChoices.get(profileId))?.models.find((m) => m.id === id); const cross = profileId !== draft.pick.profileId; update({ pick: { profileId, model: m?.isDefault ? null : id }, options: { ...draft.options, effort: draft.options.effort && m?.efforts.includes(draft.options.effort) ? draft.options.effort : undefined, permission: cross ? undefined : draft.options.permission, fast: cross ? false : draft.options.fast } }); setModelPopup(false); }} models={choices?.models ?? []} model={model} label={pickLabel(profiles.find((p) => p.id === draft.pick.profileId), model?.id ?? draft.pick.model, choices?.models).main} effort={draft.options.effort} fast={draft.options.fast} disabled={busy || !choices} fastUsage={<FastUsageHint link={link} profileId={draft.pick.profileId} />} open={modelPopup} onOpen={setModelPopup} onModel={(id) => { const m = choices?.models.find((m) => m.id === id); update({ pick: { ...draft.pick, model: m?.isDefault ? null : id }, options: { ...draft.options, effort: draft.options.effort && m?.efforts.includes(draft.options.effort) ? draft.options.effort : undefined } }); setModelPopup(false); }} onEffort={(effort) => update({ options: { ...draft.options, effort: effort ?? undefined } })} onFast={(fast) => update({ options: { ...draft.options, fast } })} footer={<button type="button" className="composer-other-accounts" onClick={() => { setModelPopup(false); setDrawer(true); }}>更多账号与模型 ›</button>} />
              <button type="button" className="btn-primary draft-send" aria-label="发送并开始新聊天" title="发送" onClick={() => void submit(false)} disabled={busy || !draft.pick.profileId || !draft.text.trim() && attach.empty} data-testid="draft-start">{busy ? "…" : "↑"}</button>
            </div>
            {drawer && <div className="draft-account-picker"><button type="button" className="link-btn" onClick={() => setDrawer(false)}>收起账号列表</button><ModelRow link={link} profiles={profiles} pick={draft.pick} onPick={(pick) => { update({ pick }); setDrawer(false); }} drawer /></div>}
            {/* DeepSeek · DSH with 工作区可写 in a project not set up for its sandbox (2026-10-23). */}
            <SandboxHint
              link={link}
              workspaceId={draft.projectId ?? workspaces.find((w) => w.builtin === "common")?.id}
              active={profiles.find((p) => p.id === draft.pick.profileId)?.runtime === "dsh" && !!choices && (draft.options.permission ?? choices.defaultPermission) === "workspace-write"}
              onUseFull={() => update({ options: { ...draft.options, permission: DSH_FULL_ACCESS } })}
            />
            {presets.length > 0 && (
              <div className="cbar presets" role="group" aria-label="常用预设">
                <span className="pick-lab">预设</span>
                {presets
                  .filter((p) => profiles.some((x) => x.id === p.profileId && !x.hidden && !x.unavailable))
                  .map((p) => {
                    const pick = { profileId: p.profileId, model: p.options.model ?? null };
                    const { model: _model, ...rest } = p.options;
                    const active = samePick(pick, draft.pick) && sameOptions(rest, draft.options);
                    return (
                      <button key={p.id} type="button" className="chip small" aria-pressed={active} onClick={() => update({ pick, options: rest })} data-testid="preset-chip">
                        {p.name}
                      </button>
                    );
                  })}
              </div>
            )}
          </div>

          {error && (
            <span className="form-error" role="alert">
              {error}
            </span>
          )}
          </>
          )}
        </div>
      </div>
      {projectPicker && <ChoicePicker noun="项目" choices={rows.projectChoices} selected={draft.projectId} noneLabel="不指定项目" onPick={(id) => { rows.pickProject(id); setProjectPicker(false); }} onClose={() => setProjectPicker(false)} />}
      {addingFiles && <AddFilesDialog attach={attach} onFind={() => setFinding({ query: "" })} onClose={() => setAddingFiles(false)} />}
      {sketching && <SketchDialog onAdd={(file) => attach.addImages([file])} onClose={() => setSketching(false)} />}
      {finding && (draft.projectId || workspaces.find((w) => w.builtin === "common")?.id) && (
        <FileSelector
          link={link}
          workspaceId={draft.projectId ?? workspaces.find((w) => w.builtin === "common")!.id}
          initialQuery={finding.query}
          onPick={(path) => attach.addFiles([path])}
          onClose={() => {
            setFinding(null);
            requestAnimationFrame(() => input.current?.focus());
          }}
        />
      )}
      {mentions.askingTemplate && (
        <PromptTemplateDialog
          link={link}
          workspaceId={draft.projectId}
          projects={projects}
          onDone={(body) => {
            const caret = mentions.finishTemplate(body);
            requestAnimationFrame(() => {
              input.current?.focus();
              if (caret !== null) input.current?.setSelectionRange(caret, caret);
            });
          }}
        />
      )}
      {mentions.askingSubsession && (
        <SubSessionDialog
          link={link}
          profiles={profiles}
          defaultPick={draft.pick}
          notes={settings?.subsessionNotes ?? []}
          onDone={(spec) => {
            const caret = mentions.finishSubsession(spec);
            requestAnimationFrame(() => {
              input.current?.focus();
              if (caret !== null) input.current?.setSelectionRange(caret, caret);
            });
          }}
        />
      )}
      {pickingResume && <ResumePicker link={link} projects={projects} projectId={draft.projectId} onPick={pickResume} onClose={() => setPickingResume(false)} />}
      {starting && <StartingCover label={starting} />}
    </section>
  );
}
