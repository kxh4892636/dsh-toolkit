#!/usr/bin/env node

/**
 * dream 输入扫描：按「Plan + 会话」游标列出新 turn，并盘点存量 Plan 与领域文档。
 *
 * 为什么按会话分游标：log.jsonl 里每个 turn 的 seq 来自宿主会话事件流，
 * 换会话后会从 4 重新开始；只按 Plan 记 lastSeq 会把新会话的 turn 全跳过。
 * 扫描与游标口径写在代码里，模型只消费输出、提交成功后调用 --mark。
 * @module @kxh4892636/dsh-toolkit/nano-flow/dream/scan
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 不扫 archived：迁 archived 是人工决定，之前的增量可丢。
const LIFECYCLES = ["active", "reference"];
const DOMAIN_DOC_KINDS = ["questions", "adr", "workflows"];
const NUMBERED_ENTRY = /^(\d{3})-/u;
const NOTE_FILE = /^\d{3}-.*\.md$/u;
const DEFAULT_DOMAINS = ".agents/domains";
const STATE_RELATIVE = path.join("toolkit", "nano-flow-dream.json");
const STATE_VERSION = 2;
const SUMMARY_CHARS = 80;
const MAX_TURNS_PER_SESSION = 30;

const listDirectories = (directory) => {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

const listEntries = (directory) => {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

const statOf = (file) => {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
};

const mtimeOf = (file) => statOf(file)?.mtime.toISOString() ?? null;

const sizeOf = (file) => statOf(file)?.size ?? null;

/** 只取头里的 status 标量：scan 是盘点不是校验，坏头按缺失处理。 */
const statusOf = (file) => {
  if (!fs.existsSync(file)) return null;
  const head = fs.readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
  return head.match(/^status:\s*"?(.+?)"?\s*$/mu)?.[1] ?? null;
};

const defaultStatePath = () => {
  const home = process.env["DSH_HOME"];
  return home === undefined || home === "" ? undefined : path.join(home, STATE_RELATIVE);
};

const emptyState = () => ({ version: STATE_VERSION, plans: {} });

const readState = (file) => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return emptyState();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyState();
  // v1 只有 Plan 级 lastSeq，分不清会话，直接视为空游标（梦的产物幂等，重跑一次安全）。
  if (raw.version !== STATE_VERSION) return emptyState();
  const plans =
    typeof raw["plans"] === "object" && raw["plans"] !== null && !Array.isArray(raw["plans"])
      ? raw["plans"]
      : {};
  return { version: STATE_VERSION, plans };
};

const writeState = (file, state) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, file);
};

const readJsonLines = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { records: [], malformed: 0 };
  }
  const records = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line);
      if (typeof record === "object" && record !== null) records.push(record);
      else malformed += 1;
    } catch {
      // 坏行计数后跳过：轨迹是只追加文件，不能因为一行坏掉整次 dream。
      malformed += 1;
    }
  }
  return { records, malformed };
};

const oneLine = (value, limit = SUMMARY_CHARS) => {
  const text = String(value ?? "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
};

const seqOf = (record) => {
  const seq = record?.seq;
  if (!Array.isArray(seq) || seq.length !== 2) return undefined;
  if (!Number.isFinite(seq[0]) || !Number.isFinite(seq[1])) return undefined;
  return [seq[0], seq[1]];
};

const turnSummary = (record) => ({
  turn: Number.isFinite(record.turn) ? record.turn : null,
  seq: seqOf(record) ?? null,
  startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
  user: oneLine(record.user),
  assistant: oneLine(record.assistant),
  tools: Array.isArray(record.tools)
    ? record.tools
        .map((tool) => (typeof tool === "object" && tool !== null ? tool.name : undefined))
        .filter((name) => typeof name === "string")
        .slice(0, 8)
    : [],
});

const lastSeqOf = (state, planPath, sessionId) => {
  const value = state.plans[planPath]?.sessions?.[sessionId]?.lastSeq;
  return Number.isFinite(value) ? value : 0;
};

/**
 * 扫一个 Plan 的 log：按会话聚合，只保留 seq 上界超过该会话游标的 turn。
 * @returns {{planPath: string, sessions: object[]} | null} 没有 log.jsonl 时返回 null。
 */
const scanPlan = (rootDir, planDirectory, state) => {
  const logFile = path.join(planDirectory, "log.jsonl");
  if (!fs.existsSync(logFile)) return null;
  const planPath = path.relative(rootDir, planDirectory).split(path.sep).join("/");
  const parsed = readJsonLines(logFile);
  const skipped = { malformed: parsed.malformed, unknown: 0, invalidTurn: 0 };
  const bySession = new Map();
  for (const record of parsed.records) {
    if (record.type !== "turn") {
      // dsh 的段头是 session；其余类型（例如 pi 的 run / backfill）记一条提示。
      if (record.type !== "session") skipped.unknown += 1;
      continue;
    }
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
    const seq = seqOf(record);
    if (sessionId === "" || seq === undefined) {
      skipped.invalidTurn += 1;
      continue;
    }
    const entry = bySession.get(sessionId) ?? {
      sessionId,
      lastSeq: lastSeqOf(state, planPath, sessionId),
      turns: [],
    };
    if (seq[1] > entry.lastSeq) entry.turns.push(turnSummary(record));
    bySession.set(sessionId, entry);
  }
  const sessions = [...bySession.values()]
    .map((entry) => ({
      ...entry,
      latestSeq: entry.turns.reduce(
        (max, turn) => Math.max(max, turn.seq?.[1] ?? 0),
        entry.lastSeq,
      ),
    }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  return { planPath, sessions, skipped };
};

/** 一个 Plan 里被跳过的记录总数。 */
const totalSkipped = (skipped) => skipped.malformed + skipped.unknown + skipped.invalidTurn;

/** 存量 Plan：不看有没有新 turn，只看目录里的事实。 */
const storedPlan = (planDirectory, planPath, lifecycle) => {
  let notesCompleted = 0;
  let notesTotal = 0;
  let latestModified = null;
  for (const entry of listEntries(planDirectory)) {
    if (!entry.isFile()) continue;
    const modified = mtimeOf(path.join(planDirectory, entry.name));
    if (modified !== null && (latestModified === null || modified > latestModified)) {
      latestModified = modified;
    }
    if (!NOTE_FILE.test(entry.name)) continue;
    notesTotal += 1;
    if (statusOf(path.join(planDirectory, entry.name)) === "completed") notesCompleted += 1;
  }
  return {
    planPath,
    lifecycle,
    specStatus: statusOf(path.join(planDirectory, "spec.md")),
    notesCompleted,
    notesTotal,
    latestModified,
    logBytes: sizeOf(path.join(planDirectory, "log.jsonl")),
  };
};

/** 一个文档目录的条目数、最大编号与 index 是否存在；workflows 的条目是子目录。 */
const docSection = (directory, kind) => {
  let count = 0;
  let maxNumber = 0;
  for (const entry of listEntries(directory)) {
    const match = NUMBERED_ENTRY.exec(entry.name);
    if (match === null || (!entry.isDirectory() && !entry.name.endsWith(".md"))) continue;
    count += 1;
    maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  return {
    kind,
    count,
    maxNumber: count === 0 ? null : maxNumber,
    hasIndex: fs.existsSync(path.join(directory, "index.md")),
  };
};

/** 领域文档盘点与落差：最新 Plan 的日期晚于 CONTEXT，说明有结论没上浮。按天比，免得同日几分钟的改动刷成落差。 */
const docInventory = (domainsRoot, domain, latestPlanModified) => {
  const domainDirectory = path.join(domainsRoot, domain);
  const contextModified = mtimeOf(path.join(domainDirectory, "CONTEXT.md"));
  return {
    domain,
    contextBytes: sizeOf(path.join(domainDirectory, "CONTEXT.md")),
    contextModified,
    sections: DOMAIN_DOC_KINDS.map((kind) => docSection(path.join(domainDirectory, kind), kind)),
    guideModified: mtimeOf(path.join(domainsRoot, "GUIDE.md")),
    latestPlanModified,
    stale:
      latestPlanModified !== null &&
      (contextModified === null || day(contextModified) < day(latestPlanModified)),
  };
};

/**
 * 扫描工作区，返回按域分组的新 turn、存量 Plan 与领域文档盘点。
 * @param {{rootDir?: string, domainsPath?: string, statePath?: string}} [options]
 * @returns {{rootDir: string, statePath: string, state: object, domains: object[],
 *   inventory: object[], docs: object[]}}
 */
const scanDreamInput = (options = {}) => {
  const rootDir = options.rootDir ?? process.cwd();
  const domainsPath = options.domainsPath ?? DEFAULT_DOMAINS;
  const statePath = options.statePath ?? defaultStatePath();
  if (statePath === undefined) throw new Error("找不到游标路径：设置 DSH_HOME 或传 --state");
  const domainsRoot = path.isAbsolute(domainsPath)
    ? domainsPath
    : path.resolve(rootDir, domainsPath);
  const state = readState(statePath);
  const report = {
    rootDir,
    statePath,
    state,
    domains: [],
    inventory: [],
    docs: [],
    warnings: [],
  };
  for (const domain of listDirectories(domainsRoot)) {
    const plans = [];
    const stored = [];
    for (const lifecycle of LIFECYCLES) {
      for (const planName of listDirectories(path.join(domainsRoot, domain, "plans", lifecycle))) {
        const planDirectory = path.join(domainsRoot, domain, "plans", lifecycle, planName);
        // 存量按目录枚举（与 ls 一致）：老 Plan 没有 log.jsonl，仍要盘点。
        const planPath = path.relative(rootDir, planDirectory).split(path.sep).join("/");
        stored.push(storedPlan(planDirectory, planPath, lifecycle));
        const scanned = scanPlan(rootDir, planDirectory, state);
        if (scanned === null) continue;
        if (totalSkipped(scanned.skipped) > 0) {
          report.warnings.push({ planPath: scanned.planPath, skipped: scanned.skipped });
        }
        if (scanned.sessions.some((session) => session.turns.length > 0)) plans.push(scanned);
      }
    }
    if (plans.length > 0) report.domains.push({ domain, plans });
    if (stored.length > 0) report.inventory.push({ domain, plans: stored });
    const latestPlanModified = stored.reduce((max, plan) => {
      if (plan.latestModified === null) return max;
      return max === null || plan.latestModified > max ? plan.latestModified : max;
    }, null);
    report.docs.push(docInventory(domainsRoot, domain, latestPlanModified));
  }
  return report;
};

/**
 * 推进「Plan + 会话」游标；同一会话只前进不后退。
 * @param {string} statePath 游标文件。
 * @param {Array<{planPath: string, sessionId: string, seq: number}>} marks 已提交的游标。
 * @returns {object} 写回后的完整状态。
 */
const applyMarks = (statePath, marks) => {
  const state = readState(statePath);
  const now = new Date().toISOString();
  for (const mark of marks) {
    const planPath = mark.planPath.split(path.sep).join("/");
    const entry = state.plans[planPath] ?? { sessions: {} };
    const sessions = entry.sessions ?? {};
    const previous = lastSeqOf(state, planPath, mark.sessionId);
    state.plans[planPath] = {
      ...entry,
      sessions: {
        ...sessions,
        [mark.sessionId]: {
          ...sessions[mark.sessionId],
          lastSeq: Math.max(previous, mark.seq),
          updatedAt: now,
        },
      },
    };
  }
  writeState(statePath, state);
  return state;
};

const formatSession = (session) => {
  const lines = [
    "- " +
      session.sessionId +
      "：游标 lastSeq " +
      session.lastSeq +
      "；新增 " +
      session.turns.length +
      " 个 turn，seq 上界 " +
      session.latestSeq,
  ];
  for (const turn of session.turns.slice(0, MAX_TURNS_PER_SESSION)) {
    const seq = turn.seq === null ? "无 seq" : turn.seq[0] + ".." + turn.seq[1];
    const tools = turn.tools.length > 0 ? "；工具 " + turn.tools.join("/") : "";
    lines.push("  - turn " + (turn.turn ?? "?") + "（" + seq + "）：" + turn.user + tools);
  }
  if (session.turns.length > MAX_TURNS_PER_SESSION) {
    lines.push(
      "  - 其余 " +
        (session.turns.length - MAX_TURNS_PER_SESSION) +
        " 个 turn 未列出，按需读 log.jsonl",
    );
  }
  return lines;
};

const day = (iso) => (iso === null ? "无" : iso.slice(0, 10));

const kb = (bytes) => (bytes === null ? "无" : Math.round(bytes / 1024) + " KB");

const padded = (value) => (value === null ? "—" : String(value).padStart(3, "0"));

/** 存量 Plan 段：每域全部 active + reference，不论有没有新 turn。 */
const formatStock = (report) => {
  const lines = ["", "## 存量 Plan（active + reference，全部）"];
  for (const group of report.inventory) {
    lines.push("", "### " + group.domain + "（" + group.plans.length + " 个）");
    for (const plan of group.plans) {
      const spec = plan.specStatus ?? "—";
      const notes = plan.notesCompleted + "/" + plan.notesTotal;
      lines.push(
        "- " +
          plan.planPath +
          "｜" +
          plan.lifecycle +
          "｜spec " +
          spec +
          "｜note " +
          notes +
          "｜最近改动 " +
          day(plan.latestModified) +
          "｜log " +
          kb(plan.logBytes),
      );
    }
  }
  return lines;
};

/** 领域文档盘点段：容量、编号进度、索引齐备度与落差标记。 */
const formatDocs = (report) => {
  const lines = ["", "## 领域文档盘点"];
  for (const docs of report.docs) {
    const sections = docs.sections
      .map(
        (section) => section.kind + " " + section.count + "（≤" + padded(section.maxNumber) + "）",
      )
      .join("/");
    const indexes = docs.sections.filter((section) => section.hasIndex).length;
    lines.push("", "### " + docs.domain);
    lines.push(
      "- CONTEXT " +
        kb(docs.contextBytes) +
        "（" +
        day(docs.contextModified) +
        "）；" +
        sections +
        "；index " +
        indexes +
        "/" +
        docs.sections.length +
        "；GUIDE " +
        (docs.guideModified === null ? "无" : "有"),
    );
    lines.push(
      docs.stale
        ? "- 域文档可能落后：是（最新 Plan " +
            day(docs.latestPlanModified) +
            " > CONTEXT " +
            day(docs.contextModified) +
            "）"
        : "- 域文档可能落后：否",
    );
  }
  return lines;
};

const formatReport = (report) => {
  const lines = ["# dream 输入", ""];
  lines.push("- 工作区：" + report.rootDir);
  lines.push(
    "- 游标：" +
      report.statePath +
      (Object.keys(report.state.plans).length === 0
        ? "（不存在、为空或旧 v1，本次按全量处理）"
        : ""),
  );
  if (report.domains.length === 0)
    lines.push("", "- 新证据：无（本轮按存量 Plan 与领域文档盘点维护）");
  for (const group of report.domains) {
    lines.push("", "## 新证据：" + group.domain + "（" + group.plans.length + " 个 Plan）");
    for (const plan of group.plans) {
      lines.push("", "#### " + plan.planPath);
      for (const session of plan.sessions) {
        if (session.turns.length === 0) continue;
        lines.push(...formatSession(session));
      }
    }
  }
  if (report.warnings.length > 0) {
    lines.push("", "## 需要留意（有记录被跳过）");
    for (const warning of report.warnings) {
      const taken = warning.skipped;
      lines.push(
        "- " +
          warning.planPath +
          "：坏行 " +
          taken.malformed +
          "、非 turn 记录 " +
          taken.unknown +
          "、无效 turn " +
          taken.invalidTurn,
      );
    }
    lines.push("  可能不是 dsh 轨迹（例如 pi 的 run 记录）或格式已变；这些记录不会被处理。");
  }
  lines.push(...formatStock(report));
  lines.push(...formatDocs(report));
  lines.push(
    "",
    "处理完、nano_flow_check 通过、git commit 成功后推进游标（只推进成功的 Plan + 会话）：",
    '  nano_flow_dream 的 mark 动作；手动调试时可用 node <本脚本> --mark "<planPath>#<sessionId>=<seq 上界>"',
  );
  return lines.join("\n");
};

const parseMark = (value) => {
  const at = value.lastIndexOf("=");
  if (at <= 0) return undefined;
  const target = value.slice(0, at);
  const seq = Number(value.slice(at + 1));
  const hash = target.lastIndexOf("#");
  if (hash <= 0 || !Number.isFinite(seq)) return undefined;
  return { planPath: target.slice(0, hash), sessionId: target.slice(hash + 1), seq };
};

const parseArgs = (argv) => {
  const options = {
    rootDir: process.cwd(),
    domainsPath: DEFAULT_DOMAINS,
    statePath: undefined,
    json: false,
    marks: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      options.rootDir = argv[(index += 1)] ?? options.rootDir;
    } else if (arg === "--domains") {
      options.domainsPath = argv[(index += 1)] ?? options.domainsPath;
    } else if (arg === "--state") {
      options.statePath = argv[(index += 1)];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--mark") {
      const mark = parseMark(argv[(index += 1)] ?? "");
      if (mark !== undefined) options.marks.push(mark);
    }
  }
  return options;
};

const run = (argv) => {
  const options = parseArgs(argv);
  if (options.marks.length > 0) {
    const statePath = options.statePath ?? defaultStatePath();
    if (statePath === undefined) throw new Error("找不到游标路径：设置 DSH_HOME 或传 --state");
    const state = applyMarks(statePath, options.marks);
    const lines = ["已推进游标：" + statePath];
    for (const mark of options.marks) {
      const planPath = mark.planPath.split(path.sep).join("/");
      lines.push(
        "- " + planPath + "#" + mark.sessionId + " → " + lastSeqOf(state, planPath, mark.sessionId),
      );
    }
    console.log(lines.join("\n"));
    return 0;
  }
  const report = scanDreamInput(options);
  console.log(options.json ? JSON.stringify(report) : formatReport(report));
  return 0;
};

/** 符号链接也认：比较 realpath，避免经 profile 路径调用时静默无输出。 */
const samePath = (left, right) => {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
};

const invoked = process.argv[1] === undefined ? "" : process.argv[1];
if (invoked !== "" && samePath(invoked, fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { scanDreamInput, applyMarks, readState, defaultStatePath, formatReport };
