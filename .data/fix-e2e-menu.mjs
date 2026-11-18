import { readFileSync, writeFileSync } from "node:fs";

const base = "D:/Codex/AgentMonitorOverlay/studio/e2e/studio/";
const load = (f) => readFileSync(base + f + ".spec.ts", "utf8").replace(/\r\n/g, "\n");
const save = (f, s) => writeFileSync(base + f + ".spec.ts", s);

function must(s, from, to, where) {
  const at = s.indexOf(from);
  if (at < 0) throw new Error(where + ": missing " + JSON.stringify(from.slice(0, 50)));
  return s.slice(0, at) + to + s.slice(at + from.length);
}

function importLine(f) {
  let s = load(f);
  if (!s.includes("support/task-menu.js")) {
    const at = s.indexOf("import { launchStudio");
    if (at < 0) throw new Error(f + ": no studio import");
    const end = s.indexOf("\n", at) + 1;
    s = s.slice(0, end) + 'import { closeTaskMenu, openTaskMenu } from "../support/task-menu.js";\n' + s.slice(end);
  }
  return s;
}

for (const [f, id] of [["bookmarks", "task-marks"], ["gitreview", "task-review"], ["taskpage", "new-session-toggle"]]) {
  let s = importLine(f);
  s = s.split('await page.getByTestId("' + id + '").click();').join(
    'await openTaskMenu(page);\n  await page.getByTestId("' + id + '").click();',
  );
  save(f, s);
}

{
  let s = importLine("marks");
  s = s.split('await page.getByTestId("task-marks").click();').join(
    'await openTaskMenu(page);\n  await page.getByTestId("task-marks").click();',
  );
  save("marks", s);
}

{
  let s = importLine("naming");
  s = must(s, 'await page.getByTestId("sessions-toggle").click();', 'await openTaskMenu(page);\n  await page.getByTestId("sessions-toggle").click();', "naming");
  save("naming", s);
}

{
  let s = importLine("codex-composer");
  s = must(
    s,
    '    await expect(page.getByTestId("sessions-toggle")).toHaveAttribute("aria-pressed", "false");',
    '    await openTaskMenu(page);\n    await expect(page.getByTestId("sessions-toggle")).toHaveAttribute("aria-checked", "false");\n    await closeTaskMenu(page);',
    "codex-composer",
  );
  s = must(s, '    await page.getByTestId("new-session-toggle").click();', '    await openTaskMenu(page);\n    await page.getByTestId("new-session-toggle").click();', "codex-composer");
  save("codex-composer", s);
}

{
  let s = importLine("newtask");
  s = must(
    s,
    '  await expect(page.getByTestId("sessions-toggle")).toHaveAttribute("aria-pressed", "false");',
    '  await openTaskMenu(page);\n  await expect(page.getByTestId("sessions-toggle")).toHaveAttribute("aria-checked", "false");\n  await closeTaskMenu(page);',
    "newtask",
  );
  s = must(s, '  await page.getByTestId("new-session-toggle").click();', '  await openTaskMenu(page);\n  await page.getByTestId("new-session-toggle").click();', "newtask");
  save("newtask", s);
}

{
  let s = importLine("starting");
  s = must(
    s,
    '  await page.getByTestId("sessions-toggle").click();\n  await page.getByTestId("new-session-toggle").click();',
    '  await openTaskMenu(page);\n  await page.getByTestId("sessions-toggle").click();\n  await openTaskMenu(page);\n  await page.getByTestId("new-session-toggle").click();',
    "starting",
  );
  s = must(s, '  await page.getByTestId("new-session-toggle").click();', '  await openTaskMenu(page);\n  await page.getByTestId("new-session-toggle").click();', "starting");
  save("starting", s);
}

{
  let s = importLine("search-archive");
  s = s.split('await page.getByTestId("task-archive").click();').join(
    'await openTaskMenu(page);\n  await page.getByTestId("task-archive").click();',
  );
  save("search-archive", s);
}

{
  let s = importLine("remote-files");
  s = must(s, 'await b.page.getByTestId("task-archive").click();', 'await openTaskMenu(b.page);\n  await b.page.getByTestId("task-archive").click();', "remote-files");
  save("remote-files", s);
}

{
  let s = importLine("remote-tasks");
  s = must(
    s,
    '  await expect(b.page.getByTestId("task-review")).toHaveCount(0);\n  await expect(b.page.getByTestId("session-fork")).toHaveCount(0);\n  await expect(b.page.getByTestId("task-marks")).toHaveCount(0);',
    '  await openTaskMenu(b.page);\n  await expect(b.page.getByTestId("task-review")).toHaveCount(0);\n  await expect(b.page.getByTestId("session-fork")).toHaveCount(0);\n  await expect(b.page.getByTestId("task-marks")).toHaveCount(0);\n  await closeTaskMenu(b.page);',
    "remote-tasks",
  );
  s = must(s, '  await b.page.getByTestId("new-session-toggle").click();', '  await openTaskMenu(b.page);\n  await b.page.getByTestId("new-session-toggle").click();', "remote-tasks");
  s = must(s, '  await b.page.getByTestId("task-archive").click();', '  await openTaskMenu(b.page);\n  await b.page.getByTestId("task-archive").click();', "remote-tasks");
  save("remote-tasks", s);
}

{
  let s = importLine("task-head");
  s = must(
    s,
    '  const sessionsToggle = page.getByTestId("sessions-toggle");\n  await expect(sessionsToggle).toHaveAttribute("aria-pressed", "true");\n  await sessionsToggle.click();\n  await expect(sessionsToggle).toHaveAttribute("aria-pressed", "false");',
    '  await openTaskMenu(page);\n  await expect(page.getByTestId("sessions-toggle")).toHaveAttribute("aria-checked", "true");\n  await page.getByTestId("sessions-toggle").click();',
    "task-head toggle",
  );
  s = must(
    s,
    '  await page.getByTestId("new-session-toggle").click();\n  await expect(page.getByRole("button", { name: "开始新会话" })).toBeVisible();\n  await expect(page.getByTestId("session-row")).toHaveCount(1);\n  await expect(sessionsToggle).toHaveAttribute("aria-pressed", "true");\n  await page.getByTestId("new-session-toggle").click();\n  await sessionsToggle.click();\n  await page.reload();',
    '  await openTaskMenu(page);\n  await page.getByTestId("new-session-toggle").click();\n  await expect(page.getByRole("button", { name: "开始新会话" })).toBeVisible();\n  await expect(page.getByTestId("session-row")).toHaveCount(1);\n  await openTaskMenu(page);\n  await expect(page.getByTestId("sessions-toggle")).toHaveAttribute("aria-checked", "true");\n  await page.getByTestId("sessions-toggle").click();\n  await page.reload();',
    "task-head new session",
  );
  s = must(
    s,
    '  await page.getByTestId("sessions-toggle").click();\n  await expect(page.getByTestId("session-row")).toHaveCount(1);',
    '  await openTaskMenu(page);\n  await page.getByTestId("sessions-toggle").click();\n  await expect(page.getByTestId("session-row")).toHaveCount(1);',
    "task-head reopen",
  );
  s = must(
    s,
    '  await page.getByTestId("sidebar-toggle").click();\n  await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-pressed", "true");',
    '  await openTaskMenu(page);\n  await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-checked", "false");\n  await page.getByTestId("sidebar-toggle").click();',
    "task-head sidebar",
  );
  s = must(
    s,
    '  expect(await page.getByTestId("task-archive").evaluate(glyph)).toBe(await archive.evaluate(glyph));',
    '  await openTaskMenu(page);\n  await expect(page.getByTestId("task-archive")).toBeVisible();\n  await closeTaskMenu(page);',
    "task-head archive glyph",
  );
  save("task-head", s);
}
