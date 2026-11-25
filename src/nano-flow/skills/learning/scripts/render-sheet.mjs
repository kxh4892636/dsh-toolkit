#!/usr/bin/env node
// cheatsheet 渲染器：Markdown -> 定尺多栏版面 -> Chrome headless 截图 PNG。
// Markdown 由随包 marked 解析，版面由 assets/sheet.html 的 CSS 负责，本脚本负责分页与截图。
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, join, dirname } from "node:path";
import { inflateSync, deflateSync } from "node:zlib";
import { marked } from "../assets/vendor/marked.esm.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let crcTable = null;
const PAGE_SIZES = { letter: [1056, 816], a4: [1123, 794] };
// 版面固定 4 栏：栏数不开放为参数，页数是唯一的旋钮。
const COLUMNS = 4;
// 固定产物: 目标目录下的 000-cheatsheet.md 与拼接图 000-cheatsheet.png, 其余都是中间件。
const SHEET = "000-cheatsheet";
// 源顶部的自引用图只给站点看，不进版面：渲染时跳过这一行，避免把上一版拼接图嵌进新版。
const SELF_IMAGE = new RegExp("^!\\[[^\\]]*\\]\\(\\.?/?000-cheatsheet\\.png\\)\\s*$");

function parseArgs(argv) {
  const out = {
    page: "a4",
    font: 5,
    dpi: 288,
    strict: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--page") out.page = argv[++i];
    else if (a === "--font") out.font = Number(argv[++i]);
    else if (a === "--dpi") out.dpi = Number(argv[++i]);
    else if (a === "--fit") out.fit = Number(argv[++i]);
    else if (a === "--source") out.source = argv[++i];
    else if (a === "--source-chars") out.sourceChars = Number(argv[++i]);
    else if (a === "--chrome") out.chrome = argv[++i];
    else if (a === "--strict") out.strict = true;
    else rest.push(a);
  }
  out.input = rest[0];
  return out;
}

function parseSheet(md) {
  const fm = {};
  let body = md;
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (m) {
    body = md.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const raw = [];
  let cur = null;
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    if (!fenced && SELF_IMAGE.test(line)) continue;
    const h2 = fenced ? null : line.match(/^##\s+(.*)$/);
    if (h2) {
      cur = { title: h2[1], md: [] };
      raw.push(cur);
      continue;
    }
    if (!cur) {
      cur = { title: "", md: [] };
      raw.push(cur);
    }
    cur.md.push(line);
  }
  return { fm, raw };
}

function findChrome(explicit) {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const opt = parseArgs(process.argv.slice(2));
if (!opt.input) {
  console.error(
    "用法: node render-sheet.mjs <目标目录 | 000-cheatsheet.md> [--fit 页数] [--font 5] [--page a4|letter] [--source 原书.md] [--strict]",
  );
  process.exit(1);
}
const chrome = findChrome(opt.chrome);
if (!chrome) {
  console.error("找不到 Chrome/Edge。用 --chrome <路径> 或 CHROME_PATH 指定。");
  process.exit(1);
}

const target = resolve(opt.input);
const targetIsDir = existsSync(target) && statSync(target).isDirectory();
const targetDir = targetIsDir ? target : dirname(target);
const inputPath = targetIsDir ? join(targetDir, SHEET + ".md") : target;
if (!existsSync(inputPath)) {
  console.error("找不到 " + inputPath + "；目标目录里应当有 " + SHEET + ".md。");
  process.exit(1);
}
const baseUrl = pathToFileURL(join(dirname(inputPath), "/")).href;
const [pw, ph] = PAGE_SIZES[opt.page] || PAGE_SIZES.a4;
const { fm, raw } = parseSheet(readFileSync(inputPath, "utf8"));

marked.setOptions({ gfm: true, breaks: false });
const sections = raw
  .map((s) => {
    const md = s.md.join("\n");
    let html = marked.parse(md);
    html = html.replace(/src="([^"]+)"/g, (all, src) =>
      /^(https?:|data:|file:)/.test(src) ? all : 'src="' + new URL(src, baseUrl).href + '"',
    );
    return { title: marked.parseInline(s.title), md: s.title + md, html };
  })
  .filter((s) => s.title || s.md.trim());

const needMermaid = sections.some((s) => s.html.includes("language-mermaid"));
const mermaidTag = needMermaid
  ? "<script>" +
    readFileSync(join(HERE, "..", "assets", "vendor", "mermaid.min.js"), "utf8").replace(
      /<\/script/gi,
      "<\\/script",
    ) +
    "</script>"
  : "";

// 中间件落系统临时目录, 目标目录只留 md 与 png。
const workDir = mkdtempSync(join(tmpdir(), "cheatsheet-"));
const htmlPath = join(workDir, "sheet.html");
const tpl = readFileSync(join(HERE, "..", "assets", "sheet.html"), "utf8");
const url = pathToFileURL(htmlPath).href;
const dsf = opt.dpi / 96;
const flags = [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--allow-file-access-from-files",
  "--force-device-scale-factor=" + dsf,
  "--window-size=" + pw + "," + ph,
];

function layout(fontPt, budget) {
  const data = {
    title: fm.title || "Cheat Sheet",
    columns: COLUMNS,
    fontPx: (fontPt * 96) / 72,
    geom: { pw, ph, pad: 12, gap: 10 },
    sections: sections.map((s) => ({ title: s.title, html: s.html })),
  };
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  writeFileSync(
    htmlPath,
    tpl.replace("__PAYLOAD__", () => payload).replace("<!--__MERMAID__-->", () => mermaidTag),
  );
  const dom = execFileSync(
    chrome,
    [...flags, "--virtual-time-budget=" + budget, "--dump-dom", url + "?page=0"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return {
    ready: dom.includes('data-ready="1"'),
    pages: Number((dom.match(/data-pages="(\d+)"/) || [])[1] || 1),
    fill: Number((dom.match(/data-fill="([\d.]+)"/) || [])[1] || 0),
    fillPages: ((dom.match(/data-fill-pages="([^"]*)"/) || [])[1] || "")
      .split(",")
      .filter(Boolean)
      .map(Number),
    warn: ((dom.match(/data-warn="([^"]*)"/) || [])[1] || "").trim(),
  };
}

function layoutWithRetry(fontPt) {
  const first = layout(fontPt, 8000);
  if (first.ready) return first;
  const second = layout(fontPt, 20000);
  if (!second.ready)
    throw new Error("版面脚本未完成（mermaid 或图片未就绪），可改用 --font 或去掉 mermaid 后重试");
  return second;
}

let fontPt = opt.font;
if (opt.fit) {
  let lo = 3.5,
    hi = 10;
  for (let k = 0; k < 7; k++) {
    const mid = (lo + hi) / 2;
    const m = layoutWithRetry(mid);
    if (m.pages > opt.fit) hi = mid;
    else lo = mid;
  }
  fontPt = Math.round(lo * 100) / 100;
}
const res = layoutWithRetry(fontPt);
if (opt.fit && res.pages > opt.fit)
  console.log(
    "页数不足: 3.5pt 下限仍需要 " + res.pages + " 页（目标 " + opt.fit + " 页），加页或删内容",
  );

const pageFiles = [];
for (let i = 0; i < res.pages; i++) {
  const file = join(workDir, "page-" + (i + 1) + ".png");
  execFileSync(chrome, [...flags, "--screenshot=" + file, url + "?page=" + i + "&export=1"], {
    stdio: "ignore",
  });
  pageFiles.push(file);
}
const stitched = stitchPng(pageFiles);
const pngPath = join(targetDir, SHEET + ".png");
writeFileSync(pngPath, stitched.data);

const chars = sections.reduce((n, s) => n + s.md.replace(/\s/g, "").length, 0);
const items = sections.reduce(
  (n, s) => n + s.md.split(/\r?\n/).filter((t) => /^\s*(-\s|\*\s|\d+\.\s)/.test(t)).length,
  0,
);
const cap = res.fill > 0 ? Math.round(chars / (res.fill * res.pages)) : 0;

const sourceChars =
  opt.sourceChars ||
  (opt.source ? readFileSync(resolve(opt.source), "utf8").replace(/\s/g, "").length : 0);
const ratio = sourceChars ? (chars / sourceChars) * 100 : 0;
const density = chars ? (items / chars) * 1000 : 0;

const pct = (n) => n.toFixed(1) + "%";
console.log(
  "sheet   : " +
    sections.length +
    " 节 / " +
    COLUMNS +
    " 栏 / " +
    res.pages +
    " 页 / " +
    chars.toLocaleString() +
    " 字 / " +
    items +
    " 条" +
    (needMermaid ? " / mermaid" : ""),
);
console.log(
  "版面    : " +
    fontPt +
    "pt，每页约 " +
    cap.toLocaleString() +
    " 字，版面填充 " +
    Math.round(res.fill * 100) +
    "%" +
    (res.fillPages.length > 1
      ? "（首页 " +
        Math.round(res.fillPages[0] * 100) +
        "% / 末页 " +
        Math.round(res.fillPages[res.fillPages.length - 1] * 100) +
        "%）"
      : ""),
);
console.log("条目密度: " + density.toFixed(1) + " 条/千字");
if (sourceChars) {
  const ok = ratio <= 3;
  console.log(
    "压缩比  : " +
      pct(ratio) +
      "（源 " +
      sourceChars.toLocaleString() +
      " 字，" +
      (ok ? "在上限 3% 内" : "超过 3% 上限，删机制或例子") +
      "）",
  );
  if (opt.strict && !ok) process.exitCode = 2;
}
if (res.warn) console.log("溢出警告: 以下节高于一栏，先拆节 -> " + res.warn);
if (!opt.fit && res.fill < 0.5)
  console.log(
    "填充偏低: 内容只占 " +
      Math.round(res.fill * 100) +
      "% 版面，加 --fit " +
      res.pages +
      " 或补内容",
  );
console.log(
  "产物    : " + inputPath + " + " + pngPath + " " + stitched.width + "×" + stitched.height,
);
rmSync(workDir, { recursive: true, force: true });

// —— PNG 竖向拼接：只依赖 zlib，不引图像库 ——
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function unfilterLine(type, cur, prev, bpp) {
  if (type === 0) return;
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v = cur[i];
    if (type === 1) v += a;
    else if (type === 2) v += b;
    else if (type === 3) v += (a + b) >> 1;
    else if (type === 4) {
      const q = a + b - c;
      const pa = Math.abs(q - a);
      const pb = Math.abs(q - b);
      const pc = Math.abs(q - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    cur[i] = v & 255;
  }
}

function decodePng(file) {
  const buf = readFileSync(file);
  let pos = 8,
    width = 0,
    height = 0,
    depth = 0,
    color = 0,
    interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += len + 12;
  }
  const bpp = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (depth !== 8 || !bpp || interlace) throw new Error("不支持该 PNG 格式: " + file);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, start + 1, start + 1 + stride);
    unfilterLine(raw[start], cur, prev, bpp);
    cur.copy(prev);
  }
  return { width, height, bpp, data: out };
}

function encodePng(width, height, bpp, data) {
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = bpp === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function stitchPng(files) {
  const pages = files.map(decodePng);
  const { width, bpp } = pages[0];
  const height = pages.reduce((n, p) => n + p.height, 0);
  const data = Buffer.alloc(width * height * bpp, 255);
  let top = 0;
  for (const p of pages) {
    if (p.bpp !== bpp || p.width !== width) throw new Error("各页尺寸不一致，无法拼接");
    p.data.copy(data, top * width * bpp);
    top += p.height;
  }
  return { data: encodePng(width, height, bpp, data), width, height };
}
