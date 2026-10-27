import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { composer, startChat, toolGroup } from "./support/chat";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/**
 * design 包里的 zh 文案（`packages/design/src/i18n.ts`，如 ActionRow 区域名 `shell.pending`）：按键从源码读出，
 * 不在用例里重复硬编码。
 */
const designZh = (key: string): string => {
  const src = readFileSync(
    new URL("../../../packages/design/src/i18n.ts", import.meta.url),
    "utf8",
  );
  const m = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]*)"`).exec(src);
  if (!m?.[1]) throw new Error(`design message ${key} not found`);
  return m[1];
};

/** 内核要求非安全方法带的 CSRF 头。 */
const CSRF = { "X-Capybara-Csrf": "1" };
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

async function currentOrg(page: Page): Promise<string> {
  let orgId: string | null = null;
  await expect
    .poll(async () => {
      const me = await page.request.get("/api/v1/me");
      orgId = me.ok() ? ((await me.json()) as { currentOrgId: string | null }).currentOrgId : null;
      return orgId;
    })
    .not.toBeNull();
  return orgId as unknown as string;
}

// ---- 最小的 zip（stored，不压缩）：只用于构造测试技能包 ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const fname = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    locals.push(local, fname, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fname.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fname);
    offset += 30 + fname.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const SKILL = "e2e-notes";

test("管理员上传技能包，agent 选用它；对话里 skill_load 的时间线摘要显示加载的技能与版本", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);

  // 1. 技能库：上传 zip（GitHub 式外层目录），列表出现该技能
  await page.goto("/zh/skills");
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await expect(page.getByText(zh.skills.upload.layoutHint)).toBeVisible();
  const zip = makeZip({
    "e2e-notes-main/SKILL.md": `---\nname: ${SKILL}\ndescription: Write notes in the house style.\n---\n# Notes\n\nUse short lines.\n`,
    "e2e-notes-main/ref/style.md": "short lines\n",
  });
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "e2e-notes-main.zip", mimeType: "application/zip", buffer: zip });
  await expect(page.getByText(fill(zh.skills.upload.created, { name: SKILL }))).toBeVisible();
  const table = page.getByRole("table", { name: zh.skills.listLabel });
  await table.getByText(SKILL, { exact: true }).click();

  // 2. 详情：SKILL.md 正文按纯文本显示
  await expect(page).toHaveURL(/\/zh\/skills\/[^/]+$/);
  await expect(page.locator("pre")).toContainText("# Notes");

  // 3. 新建 agent，在技能分组里勾选它，并置顶（skills.pinned）
  await page.goto("/zh/agents/new");
  const group = page.getByRole("group", { name: zh.agents.form.orgSkillsLabel });
  await group.getByRole("checkbox", { name: new RegExp(SKILL) }).check();
  const pinnedGroup = page.getByRole("group", { name: zh.agents.form.pinnedLabel });
  await pinnedGroup
    .getByRole("checkbox", { name: fill(zh.agents.form.pinSkill, { name: SKILL }) })
    .check();
  await page.getByRole("textbox", { name: zh.agents.form.nameLabel }).fill("Skill agent");
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);

  // 4. 对话：model-fake 按脚本调用 skill_load，时间线显示工具给的中文摘要
  const agents = (await (await page.request.get(`/api/v1/orgs/${orgId}/agents`)).json()) as {
    agents: {
      id: string;
      definition: { name: string; skills?: { orgSkills: string[]; pinned?: string[] } };
    }[];
  };
  const agent = agents.agents.find((a) => a.definition.name === "Skill agent");
  expect(agent?.definition.skills?.orgSkills).toHaveLength(1);
  expect(agent?.definition.skills?.pinned).toEqual(agent?.definition.skills?.orgSkills);
  // the edit page shows it pinned after a reload
  await page.goto(`/zh/agents/${agent?.id}`);
  await page.reload();
  await expect(
    page
      .getByRole("group", { name: zh.agents.form.pinnedLabel })
      .getByRole("checkbox", { name: fill(zh.agents.form.pinSkill, { name: SKILL }) }),
  ).toBeChecked();
  const conv = await page.request.post(`/api/v1/orgs/${orgId}/conversations`, {
    headers: CSRF,
    data: { agentId: agent?.id },
  });
  expect(conv.status(), await conv.text()).toBe(201);
  const convId = ((await conv.json()) as { conversation: { id: string } }).conversation.id;
  await page.goto(`/zh/chat/${convId}`);
  const input = composer(page);
  await input.fill(`tool:skill_load:${JSON.stringify({ name: SKILL })}`);
  await input.press("Enter");
  const tool = toolGroup(page, "skill_load");
  await expect(tool).toHaveAttribute("data-tool-status", "done");
  await expect(tool).toContainText(`加载技能 ${SKILL}（版本 1）`);
});

test("共享 agent 用 skill_write 改技能：发起人确认工具调用，负责人在收件箱看到差异并批准", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const base = `/api/v1/orgs/${orgId}`;
  const created = await page.request.post(`${base}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: "Shared writer",
        instructions: "Write skills.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "builtin", name: "skill_write" }],
      },
      visibility: "org",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
  const conv = await page.request.post(`${base}/conversations`, {
    headers: CSRF,
    data: { agentId },
  });
  const convId = ((await conv.json()) as { conversation: { id: string } }).conversation.id;
  await page.goto(`/zh/chat/${convId}`);

  // 1. 共享 agent 的 skill_write 固定要确认：发起人（也是负责人）在对话里批准工具调用
  const write = {
    name: "team-glossary",
    description: "Use for team terms.",
    files: [
      { path: "SKILL.md", content: "# Glossary\n\nSay capybara.\n" },
      { path: "terms.md", content: "capybara: the platform\n" },
    ],
  };
  const input = composer(page);
  await input.fill(`tool:skill_write:${JSON.stringify(write)}`);
  await input.press("Enter");
  const approval = page.locator('[data-role="approval"]');
  await approval.getByRole("button", { name: designZh("hitl.approve"), exact: true }).click();
  await expect(toolGroup(page, "skill_write")).toHaveAttribute("data-tool-status", "done");

  // 2. 收件箱：技能变更卡片显示 agent、文件与差异；负责人批准
  await page.goto("/zh/inbox");
  const list = page.getByRole("table", { name: zh.inbox.listLabel });
  await list.getByText(`${zh.inbox.skillChange.label} · team-glossary`).click();
  const card = page.locator("[data-skill-change-id]");
  await expect(card.getByText("Shared writer").first()).toBeVisible();
  await expect(card.getByText(zh.inbox.skillChange.newSkill)).toBeVisible();
  await expect(card.getByText(zh.inbox.skillChange.selfHint)).toBeVisible();
  await expect(card.getByText(`terms.md · ${zh.inbox.skillChange.added}`)).toBeVisible();
  await expect(
    card.getByRole("region", { name: fill(zh.inbox.skillChange.diffLabel, { path: "SKILL.md" }) }),
  ).toContainText("+ Say capybara.");
  const row = page.getByRole("region", { name: designZh("shell.pending") });
  await row.getByRole("button", { name: zh.inbox.skillChange.approve }).click();
  await expect(page.getByText(zh.inbox.skillChange.approved)).toBeVisible();
  await expect(list.getByText(`${zh.inbox.skillChange.label} · team-glossary`)).toHaveCount(0);

  // 3. 批准后成为 agent 自己的技能：编辑页只读列出
  await page.goto(`/zh/agents/${agentId}`);
  const own = page.getByRole("group", { name: zh.agents.form.ownSkillsLabel });
  await expect(own.getByText("team-glossary · v1")).toBeVisible();
});

/** Uploads a one-skill zip through the skill library page; returns the skill's id. */
async function uploadSkill(page: Page, orgId: string, name: string, md: string): Promise<string> {
  await page.goto("/zh/skills");
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: `${name}.zip`,
    mimeType: "application/zip",
    buffer: makeZip({ [`${name}/SKILL.md`]: md }),
  });
  await expect(page.getByText(fill(zh.skills.upload.created, { name }))).toBeVisible();
  const list = (await (await page.request.get(`/api/v1/orgs/${orgId}/skills`)).json()) as {
    skills: { id: string; name: string }[];
  };
  const id = list.skills.find((s) => s.name === name)?.id;
  expect(id).toBeDefined();
  return id as string;
}

test("phase D: invoke skills from the / menu and typed, queue one, run a forked one; a manual skill is in the menu, not the model's catalog", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const fix = await uploadSkill(
    page,
    orgId,
    "e2e-fix-issue",
    "---\nname: e2e-fix-issue\ndescription: Fix a GitHub issue.\nargument-hint: '[issue-number]'\n---\nFix GitHub issue $ARGUMENTS.\n",
  );
  const manual = await uploadSkill(
    page,
    orgId,
    "e2e-manual-check",
    "---\nname: e2e-manual-check\ndescription: Run the manual checks.\ndisable-model-invocation: true\n---\nRun the manual checks.\n",
  );
  const review = await uploadSkill(
    page,
    orgId,
    "e2e-review",
    "---\nname: e2e-review\ndescription: Review in a sub-agent.\ncontext: fork\n---\nReview $ARGUMENTS.\n",
  );
  const created = await page.request.post(`/api/v1/orgs/${orgId}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: "Skill invoker",
        instructions: "Help.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [],
        skills: { orgSkills: [fix, manual, review] },
      },
      visibility: "private",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  await startChat(page, "Skill invoker");
  const input = composer(page);
  // finished replies only (a streaming draft is a prose entry too)
  const answered = page.locator('[data-entry="prose"]:not([data-streaming="true"])');
  const bubble = (skill: string) =>
    page
      .locator('[data-entry="user"]')
      .filter({ has: page.locator('[data-part="bubble-skill"]', { hasText: skill }) });

  // 1. the / menu: skills first, tagged; filter, pick, the chip, the arguments
  await input.press("/");
  const palette = page.getByRole("dialog");
  await expect(palette.getByRole("option", { name: /^\/e2e-fix-issue/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /^\/e2e-manual-check/ })).toContainText(
    zh.chat.skillTag.manual,
  );
  await expect(palette.getByRole("option", { name: /^\/e2e-review/ })).toContainText(
    zh.chat.skillTag.fork,
  );
  await palette.getByRole("combobox").fill("fix-iss");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await palette.getByRole("option", { name: /^\/e2e-fix-issue/ }).click();
  await expect(page.locator('[data-part="composer-token"]')).toContainText("/e2e-fix-issue");
  await expect(input).toHaveAttribute("placeholder", "[issue-number]");
  await input.fill("123");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/zh\/chat\/[^/?#]+(#.*)?$/);
  const first = bubble("/e2e-fix-issue");
  await expect(first.locator('[data-part="bubble"]')).toHaveText("/e2e-fix-issue123");
  await first.getByRole("button", { name: zh.chat.skillInstructions }).click();
  await expect(first).toContainText("Fix GitHub issue 123.");
  await expect(first).toContainText('<skill_invocation name="e2e-fix-issue" version="1">');
  await expect(answered).toHaveCount(1, { timeout: 60_000 });

  // 2. typed /name args, no menu: the manual-only skill
  await input.fill("/e2e-manual-check now");
  await input.press("Enter");
  await expect(bubble("/e2e-manual-check").locator('[data-part="bubble"]')).toHaveText(
    "/e2e-manual-checknow",
  );
  await expect(answered).toHaveCount(2, { timeout: 60_000 });
  const convId = new URL(page.url()).pathname.split("/").at(-1) as string;
  const events = (
    (await (
      await page.request.get(`/api/v1/orgs/${orgId}/conversations/${convId}/events?limit=500`)
    ).json()) as {
      events: {
        type: string;
        payload: { skills?: { name: string }[]; skill?: { name: string } };
      }[];
    }
  ).events;
  // the model's catalog lists the model-invocable skills only
  const catalog = events.find((e) => e.type === "skills_catalog");
  const names = (catalog?.payload.skills ?? []).map((s) => s.name);
  expect(names).toContain("e2e-fix-issue");
  expect(names).toContain("e2e-review");
  expect(names).not.toContain("e2e-manual-check");
  expect(events.filter((e) => e.type === "user_message").map((e) => e.payload.skill?.name)).toEqual(
    ["e2e-fix-issue", "e2e-manual-check"],
  );

  // 3. queued while running: the queued bubble carries the chip, then it goes out
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  await input.fill(`slow:300:${long}`);
  await input.press("Enter");
  // the send has landed (the composer is clear) and the reply streams
  await expect(page.locator('[data-entry="user"]').filter({ hasText: "slow:300:" })).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(page.locator('[data-entry="prose"][data-streaming="true"]')).toBeVisible();
  await input.fill("/e2e-fix-issue 9");
  await input.press("ControlOrMeta+Enter");
  const queue = page.locator('[data-entry="queue"]');
  await expect(queue.locator('[data-part="bubble-skill"]')).toHaveText("/e2e-fix-issue");
  await expect(queue).toHaveCount(0, { timeout: 60_000 });
  await expect(bubble("/e2e-fix-issue").last().locator('[data-part="bubble"]')).toHaveText(
    "/e2e-fix-issue9",
  );
  await expect(answered).toHaveCount(4, { timeout: 60_000 });

  // 4. a forked skill: the sub-agent row under the bubble, the report, then the reply
  await input.fill("/e2e-review src");
  await input.press("Enter");
  await expect(bubble("/e2e-review").locator('[data-part="bubble"]')).toHaveText("/e2e-reviewsrc");
  const report = page.locator('[data-entry="skill-report"]');
  await expect(report).toHaveCount(1, { timeout: 60_000 });
  const rows = page.locator('[data-entry="subagents"]');
  await expect(rows.last()).toContainText(designZh("subagent.done").replace("{n}", "1"));
  await report.getByRole("button", { name: zh.chat.skillReport }).click();
  await expect(report).toContainText('Report from the sub-agent that ran the skill "e2e-review"');
  await expect(answered).toHaveCount(5, { timeout: 60_000 });
  const kinds = await page
    .locator("[data-entry]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-entry")));
  const at = kinds.lastIndexOf("subagents");
  expect(kinds.slice(at - 1, at + 2)).toEqual(["user", "subagents", "skill-report"]);
});
