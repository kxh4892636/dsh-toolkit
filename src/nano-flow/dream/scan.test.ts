import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { applyMarks, formatReport, scanDreamInput } from "./scan.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "dream-scan-"));
  roots.push(root);
  return root;
};

const PLAN = "2026-01-01-示例";
const PLAN_PATH = ".agents/domains/demo/plans/active/" + PLAN;
const SESSION_A = "session-a";
const SESSION_B = "session-b";

const writeLog = async (
  root: string,
  lines: readonly string[],
  planPath: string = PLAN_PATH,
): Promise<void> => {
  const directory = join(root, planPath);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "log.jsonl"), lines.join("\n") + "\n", "utf8");
};

const touch = async (file: string, iso: string): Promise<void> => {
  const date = new Date(iso);
  await utimes(file, date, date);
};

const frontmatter = (name: string, status: string): string =>
  "---\nname: " + name + "\ndescription: 示例\nstatus: " + status + "\n---\n";

const turn = (sessionId: string, number: number, from: number, to: number, user: string): string =>
  JSON.stringify({
    type: "turn",
    v: 1,
    sessionId,
    turn: number,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    user,
    assistant: "回复 " + number,
    tools: [{ name: "bash", ok: true }],
    usage: {},
    seq: [from, to],
  });

const header = (sessionId: string): string =>
  JSON.stringify({ type: "session", v: 1, sessionId, planPath: PLAN_PATH });

const writeCursor = async (root: string, state: unknown): Promise<string> => {
  const statePath = join(root, "cursor.json");
  await writeFile(statePath, JSON.stringify(state), "utf8");
  return statePath;
};

const planOf = (report: ReturnType<typeof scanDreamInput>) => report.domains[0]?.plans[0];

describe("scanDreamInput", () => {
  it("treats a missing cursor as full scan and groups by domain", async () => {
    const root = await makeRoot();
    await writeLog(root, [header(SESSION_A), turn(SESSION_A, 1, 4, 533, "第一轮")]);
    const report = scanDreamInput({ rootDir: root, statePath: join(root, "cursor.json") });
    const plan = planOf(report);
    expect(report.domains[0]?.domain).toBe("demo");
    expect(plan?.planPath).toBe(PLAN_PATH);
    expect(plan?.sessions[0]?.sessionId).toBe(SESSION_A);
    expect(plan?.sessions[0]?.lastSeq).toBe(0);
    expect(plan?.sessions[0]?.latestSeq).toBe(533);
    expect(plan?.sessions[0]?.turns[0]?.seq).toEqual([4, 533]);
    expect(plan?.sessions[0]?.turns[0]?.tools).toEqual(["bash"]);
  });

  it("keeps cursors per session because seq restarts in a new session", async () => {
    const root = await makeRoot();
    await writeLog(root, [
      header(SESSION_A),
      turn(SESSION_A, 1, 4, 533, "A 第一轮"),
      turn(SESSION_A, 2, 535, 1368, "A 第二轮"),
      header(SESSION_B),
      turn(SESSION_B, 1, 4, 102, "B 第一轮"),
    ]);
    const statePath = await writeCursor(root, {
      version: 2,
      plans: { [PLAN_PATH]: { sessions: { [SESSION_A]: { lastSeq: 533 } } } },
    });
    const plan = planOf(scanDreamInput({ rootDir: root, statePath }));
    const a = plan?.sessions.find((session) => session.sessionId === SESSION_A);
    const b = plan?.sessions.find((session) => session.sessionId === SESSION_B);
    expect(a?.turns.map((item) => item.turn)).toEqual([2]);
    expect(b?.turns.map((item) => item.turn)).toEqual([1]);
    expect(b?.lastSeq).toBe(0);
  });

  it("ignores a v1 cursor and rescans everything", async () => {
    const root = await makeRoot();
    await writeLog(root, [header(SESSION_A), turn(SESSION_A, 1, 4, 533, "第一轮")]);
    const statePath = await writeCursor(root, {
      version: 1,
      plans: { [PLAN_PATH]: { lastSeq: 533 } },
    });
    const plan = planOf(scanDreamInput({ rootDir: root, statePath }));
    expect(plan?.sessions[0]?.turns).toHaveLength(1);
  });

  it("keeps stock plans when nothing is new", async () => {
    const root = await makeRoot();
    await writeLog(root, [header(SESSION_A), turn(SESSION_A, 1, 4, 533, "第一轮")]);
    const statePath = await writeCursor(root, {
      version: 2,
      plans: { [PLAN_PATH]: { sessions: { [SESSION_A]: { lastSeq: 533 } } } },
    });
    const report = scanDreamInput({ rootDir: root, statePath });
    expect(report.domains).toEqual([]);
    expect(report.inventory[0]?.plans[0]?.planPath).toBe(PLAN_PATH);
  });

  it("reports skipped records for foreign or broken logs", async () => {
    const root = await makeRoot();
    await writeLog(root, [
      JSON.stringify({ type: "run", v: 1, sessionId: "pi", run: 1, entries: [] }),
      JSON.stringify({ type: "run", v: 1, sessionId: "pi", run: 2, entries: [] }),
      "{oops",
    ]);
    const report = scanDreamInput({ rootDir: root, statePath: join(root, "cursor.json") });
    expect(report.domains).toEqual([]);
    expect(report.warnings).toEqual([
      { planPath: PLAN_PATH, skipped: { malformed: 1, unknown: 2, invalidTurn: 0 } },
    ]);
  });

  it("still prints the stock and inventory sections when nothing is new", async () => {
    const root = await makeRoot();
    await writeLog(root, [header(SESSION_A), turn(SESSION_A, 1, 4, 533, "第一轮")]);
    await writeFile(join(root, PLAN_PATH, "spec.md"), frontmatter(PLAN, "in_progress"), "utf8");
    const doneNote = join(root, PLAN_PATH, "001-已完成.md");
    await writeFile(doneNote, frontmatter("001-已完成", "completed"), "utf8");
    await writeFile(
      join(root, PLAN_PATH, "002-待办.md"),
      frontmatter("002-待办", "pending"),
      "utf8",
    );
    const referencePath = ".agents/domains/demo/plans/reference/2025-12-01-旧计划";
    await mkdir(join(root, referencePath), { recursive: true });
    const referenceSpec = join(root, referencePath, "spec.md");
    await writeFile(referenceSpec, frontmatter("2025-12-01-旧计划", "completed"), "utf8");
    const statePath = await writeCursor(root, {
      version: 2,
      plans: { [PLAN_PATH]: { sessions: { [SESSION_A]: { lastSeq: 533 } } } },
    });
    const report = scanDreamInput({ rootDir: root, statePath });
    const plan = report.inventory[0]?.plans[0];
    // 老 Plan 没有 log.jsonl，仍要按目录盘点。
    expect(report.inventory[0]?.plans.map((item) => item.planPath)).toEqual([
      PLAN_PATH,
      referencePath,
    ]);
    expect(report.inventory[0]?.plans[1]?.logBytes).toBeNull();
    expect(report.domains).toEqual([]);
    expect(plan?.lifecycle).toBe("active");
    expect(plan?.specStatus).toBe("in_progress");
    expect(plan?.notesCompleted).toBe(1);
    expect(plan?.notesTotal).toBe(2);
    expect(plan?.logBytes).toBeGreaterThan(0);
    expect(report.docs[0]?.domain).toBe("demo");
    const text = formatReport(report);
    expect(text).toContain("新证据：无");
    expect(text).toContain("## 存量 Plan");
    expect(text).toContain("## 领域文档盘点");
    expect(text).toContain("｜spec in_progress｜note 1/2｜");
  });

  it("leaves archived plans out of the scan", async () => {
    const root = await makeRoot();
    const archivedPath = ".agents/domains/demo/plans/archived/" + PLAN;
    await writeLog(root, [header(SESSION_A), turn(SESSION_A, 1, 4, 533, "第一轮")], archivedPath);
    await writeLog(root, [header(SESSION_A), turn(SESSION_A, 1, 4, 533, "第一轮")]);
    const report = scanDreamInput({ rootDir: root, statePath: join(root, "cursor.json") });
    expect(report.domains[0]?.plans.map((item) => item.planPath)).toEqual([PLAN_PATH]);
    expect(report.inventory[0]?.plans.map((item) => item.planPath)).toEqual([PLAN_PATH]);
    expect(report.inventory[0]?.plans[0]?.lifecycle).toBe("active");
  });

  it("flags a domain as possibly stale when its newest plan beats CONTEXT.md", async () => {
    const root = await makeRoot();
    await writeLog(root, [header(SESSION_A), turn(SESSION_A, 1, 4, 533, "第一轮")]);
    const contextFile = join(root, ".agents/domains/demo/CONTEXT.md");
    await writeFile(contextFile, "# demo\n", "utf8");
    await touch(join(root, PLAN_PATH, "log.jsonl"), "2026-02-01T00:00:00.000Z");
    await touch(contextFile, "2026-01-01T00:00:00.000Z");
    const statePath = join(root, "cursor.json");
    const stale = scanDreamInput({ rootDir: root, statePath });
    expect(stale.docs[0]?.stale).toBe(true);
    expect(stale.docs[0]?.latestPlanModified).toBe("2026-02-01T00:00:00.000Z");
    expect(formatReport(stale)).toContain(
      "域文档可能落后：是（最新 Plan 2026-02-01 > CONTEXT 2026-01-01）",
    );
    await touch(contextFile, "2026-02-01T09:00:00.000Z");
    expect(scanDreamInput({ rootDir: root, statePath }).docs[0]?.stale).toBe(false);
    await touch(contextFile, "2026-03-01T00:00:00.000Z");
    const fresh = scanDreamInput({ rootDir: root, statePath });
    expect(fresh.docs[0]?.stale).toBe(false);
    expect(formatReport(fresh)).toContain("域文档可能落后：否");
  });

  it("skips malformed log lines instead of failing", async () => {
    const root = await makeRoot();
    await writeLog(root, [header(SESSION_A), "{oops", turn(SESSION_A, 1, 4, 533, "第一轮")]);
    const plan = planOf(scanDreamInput({ rootDir: root, statePath: join(root, "cursor.json") }));
    expect(plan?.sessions[0]?.turns).toHaveLength(1);
  });
});

describe("applyMarks", () => {
  it("writes the seq upper bound per session and never moves backwards", async () => {
    const root = await makeRoot();
    const statePath = await writeCursor(root, { version: 2, plans: {} });
    applyMarks(statePath, [{ planPath: PLAN_PATH, sessionId: SESSION_A, seq: 1368 }]);
    const state = applyMarks(statePath, [
      { planPath: PLAN_PATH, sessionId: SESSION_A, seq: 10 },
      { planPath: PLAN_PATH, sessionId: SESSION_B, seq: 533 },
    ]);
    expect(state.plans[PLAN_PATH]?.sessions[SESSION_A]?.lastSeq).toBe(1368);
    expect(state.plans[PLAN_PATH]?.sessions[SESSION_B]?.lastSeq).toBe(533);
  });

  it("makes the next scan see nothing new", async () => {
    const root = await makeRoot();
    await writeLog(root, [header(SESSION_A), turn(SESSION_A, 1, 4, 533, "第一轮")]);
    const statePath = join(root, "cursor.json");
    applyMarks(statePath, [{ planPath: PLAN_PATH, sessionId: SESSION_A, seq: 533 }]);
    const report = scanDreamInput({ rootDir: root, statePath });
    expect(report.domains).toEqual([]);
  });
});
