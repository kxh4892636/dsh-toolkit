#!/usr/bin/env python3
"""笔记形态检测：只输出「参考值 + 实测值」，不给修改建议。

用法:
    python3 note-metrics.py <目录或文件>... [--detail] [--json] [--exclude <路径子串>]

口径与 NOTE.md 一致:
    - 每节条数: 笔记按 H2 计数, 速查卡 ( 000-cheatsheet.md 或 *.cheatsheet.md ) 按 H3 计数;
    - 参考值固定写在本文件，改动需同步 NOTE.md。

分位数用线性插值，保留 1 位小数；超限阈值是每节 8 条。
"""

from __future__ import annotations

import json
import os
import re
import sys
import unicodedata

# NOTE.md 里的每节条数分布数值；这里是唯一实现，脚本与文档要保持一致。
REFERENCE = {"section": {"mean": 3.5, "p50": 3.0, "p90": 6.0, "over8": 2.2}}

# 超长阈值: 每节 8 条。
LIMITS = {"section": 8}

BULLET = re.compile(r"^\s*[-*] ")
FENCE = re.compile(r"^\s*```")
H2 = re.compile(r"^## ")
H3 = re.compile(r"^### ")
# 速查卡源固定叫 000-cheatsheet.md; 兼容旧命名 <主题>.cheatsheet.md
CHEATSHEET_NAMES = ("000-cheatsheet.md",)
CHEATSHEET_SUFFIX = ".cheatsheet.md"


def is_cheatsheet(file: str) -> bool:
    name = os.path.basename(file)
    return name in CHEATSHEET_NAMES or name.endswith(CHEATSHEET_SUFFIX)


def collect_files(targets: list[str], excludes: list[str]) -> tuple[list[str], list[str]]:
    """递归收集 Markdown 笔记，跳过 README.md 与命中的排除子串。"""
    files: list[str] = []
    missing: list[str] = []
    for target in targets:
        if any(pattern in target for pattern in excludes):
            continue
        if not os.path.exists(target):
            missing.append(target)
            continue
        if os.path.isfile(target):
            if target.endswith(".md") and os.path.basename(target) != "README.md":
                files.append(target)
            continue
        for root, dirs, names in os.walk(target):
            dirs[:] = sorted(d for d in dirs if not any(pattern in os.path.join(root, d) for pattern in excludes))
            for name in sorted(names):
                path = os.path.join(root, name)
                if not name.endswith(".md") or name == "README.md":
                    continue
                if any(pattern in path for pattern in excludes):
                    continue
                files.append(path)
    return files, missing


def body_lines(rows: list[str]) -> list[str]:
    """去掉 frontmatter 与围栏代码块, 只留正文行。"""
    start = 0
    if rows and rows[0].strip() == "---":
        start = 1
        while start < len(rows) and rows[start].strip() != "---":
            start += 1
        start += 1

    kept: list[str] = []
    fence = False
    for line in rows[start:]:
        if FENCE.match(line):
            fence = not fence
            continue
        if not fence:
            kept.append(line)
    return kept


def heading_of(file: str, lines: list[str]) -> re.Pattern[str]:
    """数节的标题级别: 速查卡按 H3, 其余按 H2; 速查卡没有 H3 时退回 H2。"""
    if is_cheatsheet(file) and any(H3.match(line) for line in lines):
        return H3
    return H2


def read_note(file: str) -> dict:
    """解析一份笔记: 条目总数、每节条数。"""
    with open(file, encoding="utf-8") as handle:
        rows = handle.read().split("\n")
    if rows and rows[-1] == "":
        rows.pop()

    lines = body_lines(rows)
    head = heading_of(file, lines)
    bullets = 0
    sections: list[int] = []
    current: int | None = None
    for line in lines:
        if head.match(line):
            if current is not None:
                sections.append(current)
            current = 0
            continue
        if BULLET.match(line):
            bullets += 1
            if current is not None:
                current += 1
    if current is not None:
        sections.append(current)

    return {"file": file, "bullets": bullets, "section": sections}


def quantile(values: list[float], percent: float) -> float:
    """线性插值分位数; 输入无需预排序。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent / 100
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def mean(values: list[float]) -> float:
    return 0.0 if not values else sum(values) / len(values)


def percent(count: int, total: int) -> float:
    return 0.0 if total == 0 else count / total * 100


def summarize(notes: list[dict]) -> dict:
    """汇总每节条数分布。"""
    sections = [value for note in notes for value in note["section"]]
    rnd = lambda value: round(value, 1)  # noqa: E731
    return {
        "files": len(notes),
        "bulletCount": sum(note["bullets"] for note in notes),
        "sectionCount": len(sections),
        "section": {
            "mean": rnd(mean(sections)),
            "p50": rnd(quantile(sections, 50)),
            "p90": rnd(quantile(sections, 90)),
            "over8": rnd(percent(sum(1 for value in sections if value > LIMITS["section"]), len(sections))),
        },
    }


def rows(summary: dict) -> list[list[str]]:
    one = lambda value: f"{value:.1f}"  # noqa: E731
    return [
        ["每节条数", "均值", one(REFERENCE["section"]["mean"]), one(summary["section"]["mean"])],
        ["", "P50", one(REFERENCE["section"]["p50"]), one(summary["section"]["p50"])],
        ["", "P90", one(REFERENCE["section"]["p90"]), one(summary["section"]["p90"])],
        ["", "超 8 条占比 %", one(REFERENCE["section"]["over8"]), one(summary["section"]["over8"])],
    ]


def width_of(text: str) -> int:
    """显示宽度: 全角与 CJK 记 2 列。"""
    return sum(2 if unicodedata.east_asian_width(char) in "WF" else 1 for char in text)


def render(summary: dict) -> str:
    header = ["指标", "统计量", "参考", "实测"]
    body = rows(summary)
    widths = [max(width_of(header[i]), *(width_of(row[i]) for row in body)) + 2 for i in range(4)]
    line = lambda cells: "".join(  # noqa: E731
        cell + " " * max(0, widths[index] - width_of(cell)) for index, cell in enumerate(cells)
    ).rstrip()
    divider = " ".join("─" * (size - 1) for size in widths)
    out = [
        f"篇数 {summary['files']} · 条目 {summary['bulletCount']} · 小节 {summary['sectionCount']}",
        line(header),
        divider,
        *(line(row) for row in body),
    ]
    return "\n".join(out)


def split_args(argv: list[str]) -> tuple[list[str], list[str], bool, bool]:
    detail = "--detail" in argv
    as_json = "--json" in argv
    excludes: list[str] = []
    targets: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--exclude" and index + 1 < len(argv):
            excludes.append(argv[index + 1])
            index += 2
            continue
        if arg.startswith("--exclude="):
            excludes.append(arg.split("=", 1)[1])
        elif not arg.startswith("--"):
            targets.append(arg)
        index += 1
    return targets, excludes, detail, as_json


def main(argv: list[str]) -> int:
    targets, excludes, detail, as_json = split_args(argv)
    if not targets:
        sys.stderr.write("用法: python3 note-metrics.py <目录或文件>... [--detail] [--json] [--exclude <路径子串>]\n")
        return 2
    files, missing = collect_files(targets, excludes)
    if missing:
        sys.stderr.write(f"路径不存在: {', '.join(missing)}\n")
    if not files:
        sys.stderr.write("没有找到 Markdown 笔记\n")
        return 1
    notes = [read_note(file) for file in files]
    summary = summarize(notes)
    if as_json:
        payload = {"summary": summary}
        if detail:
            payload["notes"] = [
                {"file": note["file"], "bullets": note["bullets"], "sections": len(note["section"])}
                for note in notes
            ]
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        return 0
    sys.stdout.write(render(summary) + "\n")
    if detail:
        sys.stdout.write("\n逐篇现状（小节数 / 条目数）\n")
        for note in sorted(notes, key=lambda item: len(item["section"]), reverse=True):
            sys.stdout.write(f"{len(note['section']):>3} / {note['bullets']:>3}  {note['file']}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
