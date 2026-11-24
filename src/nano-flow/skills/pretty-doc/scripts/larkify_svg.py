#!/usr/bin/env python3
"""Turn a diagram-design SVG into a Lark whiteboard-safe SVG.

The whiteboard parser keeps only presentation attributes: it ignores <style>
and class names, drops patterns and clipping, and does not load remote fonts.
This script:

1. inlines the SVG's CSS onto every element;
2. maps diagram-design's default skin to the Lark palette;
3. removes unsupported decoration and the dotted paper background;
4. validates that the result is a self-contained <svg> with a viewBox.

Usage:
    python3 larkify_svg.py diagram.svg diagram.lark.svg \
        --palette assets/lark-palette.json

No third-party dependencies.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
ET.register_namespace("", SVG_NS)

TARGET = {
    "fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity",
    "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin",
    "opacity", "font-family", "font-size", "font-weight", "font-style",
    "letter-spacing", "text-anchor", "dominant-baseline", "stop-color",
    "stop-opacity", "paint-order",
}
INHERITED = {
    "color", "font-family", "font-size", "font-weight", "font-style",
    "letter-spacing", "text-anchor",
}
TEXT_PROPS = {
    "font-family", "font-size", "font-weight", "font-style",
    "letter-spacing", "text-anchor", "dominant-baseline",
}
COLOR_ATTRS = ("fill", "stroke", "stop-color", "color", "flood-color", "lighting-color")
DROP_TAGS = {"style", "pattern", "clipPath", "mask", "filter", "script", "foreignObject"}


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def split_top(text: str, sep: str) -> list[str]:
    out, buf, depth = [], "", 0
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == sep and depth == 0:
            out.append(buf)
            buf = ""
        else:
            buf += ch
    out.append(buf)
    return [item.strip() for item in out if item.strip()]


def parse_decls(body: str) -> list[tuple[str, str]]:
    decls = []
    for part in split_top(body, ";"):
        if ":" not in part:
            continue
        prop, value = part.split(":", 1)
        value = re.sub(r"\s*!important\s*$", "", value.strip(), flags=re.I)
        decls.append((prop.strip().lower(), value))
    return decls


def parse_css(text: str) -> list[tuple[str, list[tuple[str, str]]]]:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"@import[^;]*;", "", text)
    text = re.sub(r"@media[^{]*\{.*?\}\s*\}\s*", "", text, flags=re.S)
    rules = []
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", text):
        for selector in split_top(match.group(1), ","):
            rules.append((selector, parse_decls(match.group(2))))
    return rules


TOKEN = re.compile(r"(#[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9_-]*|\*)")


def compound_match(node: ET.Element, compound: str) -> bool:
    tag = local(node.tag)
    node_id = node.get("id")
    classes = set((node.get("class") or "").split())
    for token in TOKEN.findall(compound):
        if token == "*":
            continue
        if token.startswith("#"):
            if node_id != token[1:]:
                return False
        elif token.startswith("."):
            if token[1:] not in classes:
                return False
        elif tag != token:
            return False
    return True


def selector_match(node: ET.Element, selector: str, ancestors: list[ET.Element]) -> bool:
    parts = selector.replace(">", " ").split()
    if not parts or not compound_match(node, parts[-1]):
        return False
    index = len(parts) - 2
    for ancestor in reversed(ancestors):
        if index < 0:
            break
        if compound_match(ancestor, parts[index]):
            index -= 1
    return index < 0


def specificity(selector: str) -> tuple[int, int, int]:
    ids = selector.count("#")
    classes = selector.count(".") + selector.count(":")
    tags = len(re.findall(r"(?:^|[\s>])([A-Za-z][A-Za-z0-9_-]*)", selector))
    return ids, classes, tags


def resolve_vars(value: str, variables: dict[str, str], depth: int = 0) -> str:
    if depth > 20 or "var(" not in value:
        return value

    def replace(match: re.Match[str]) -> str:
        name, fallback = match.group(1), match.group(2)
        if name in variables:
            return resolve_vars(variables[name], variables, depth + 1)
        return fallback.strip() if fallback else ""

    return re.sub(r"var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)", replace, value).strip()


def load_palette(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    with open(path, encoding="utf-8") as handle:
        raw = json.load(handle)
    return {re.sub(r"\s+", "", key.lower()): value for key, value in raw.items()}


def map_color(value: str, palette: dict[str, str]) -> str:
    if not palette:
        return value
    key = re.sub(r"\s+", "", value.lower())
    if key in palette:
        return palette[key]
    return palette.get(key, value)


def norm_hex(value: str) -> str | None:
    value = value.strip().lower()
    if re.fullmatch(r"#[0-9a-f]{3}", value):
        return "#" + "".join(ch * 2 for ch in value[1:])
    if re.fullmatch(r"#[0-9a-f]{6}", value):
        return value
    return None


def normalize_color(value: str | None, palette: dict[str, str]) -> tuple[str | None, float | None]:
    if value is None:
        return None, None
    value = value.strip()
    if value == "none":
        return "none", None
    if value == "transparent":
        return "none", None
    mapped = map_color(value, palette)
    match = re.fullmatch(
        r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)",
        mapped,
    )
    if match:
        red, green, blue = (int(match.group(i)) for i in (1, 2, 3))
        alpha = float(match.group(4)) if match.group(4) is not None else 1.0
        color = f"#{red:02x}{green:02x}{blue:02x}"
        return map_color(color, palette), (alpha if alpha < 1 else None)
    hex_value = norm_hex(mapped)
    if hex_value:
        return map_color(hex_value, palette), None
    return mapped, None


def check_external(root: ET.Element) -> list[str]:
    warnings = []
    for node in root.iter():
        if local(node.tag) == "image":
            warnings.append("contains <image>; whiteboards prefer vector shapes")
        for key in ("href", f"{{{XLINK_NS}}}href"):
            value = node.get(key) or ""
            if value.startswith(("http://", "https://")):
                warnings.append(f"external reference on <{local(node.tag)}>: {value}")
    return warnings


def convert(source: str, target: str, palette_path: str | None) -> list[str]:
    tree = ET.parse(source)
    root = tree.getroot()
    if local(root.tag) != "svg":
        raise SystemExit("error: input is not an <svg> document")
    if not root.get("viewBox"):
        raise SystemExit("error: <svg> has no viewBox; export it from diagram-design first")

    palette = load_palette(palette_path)
    styles = [node.text or "" for node in root.iter() if local(node.tag) == "style"]
    rules = parse_css("\n".join(styles))

    variables: dict[str, str] = {}
    root_id = root.get("id")
    for selector, decls in rules:
        name = selector.strip()
        if name in (":root", "svg") or (root_id and name == f"#{root_id}"):
            for prop, value in decls:
                if prop.startswith("--"):
                    variables[prop] = value

    dropped_ids: set[str] = set()
    for node in list(root.iter()):
        if local(node.tag) in DROP_TAGS - {"style", "script", "foreignObject"}:
            node_id = node.get("id")
            if node_id:
                dropped_ids.add(node_id)

    def walk(node, ancestors, inherited):
        computed = dict(inherited)
        matched = []
        for order, (selector, decls) in enumerate(rules):
            if selector_match(node, selector, ancestors):
                matched.append((specificity(selector), order, decls))
        matched.sort(key=lambda item: (item[0], item[1]))
        for _, _, decls in matched:
            for prop, value in decls:
                computed[prop] = resolve_vars(value, variables)
        inline = node.get("style")
        if inline:
            for prop, value in parse_decls(inline):
                computed[prop] = resolve_vars(value, variables)

        if local(node.tag) not in DROP_TAGS:
            for attr in ("clip-path", "mask", "filter"):
                value = node.get(attr)
                if value and any(item in value for item in dropped_ids):
                    node.attrib.pop(attr, None)
            for attr in ("fill", "stroke"):
                value = computed.get(attr) or node.get(attr)
                if value and value.startswith("url(#"):
                    ref = value[5:-1]
                    if ref in dropped_ids:
                        full_bleed = (
                            local(node.tag) == "rect"
                            and node.get("x", "0") in ("0", "0px")
                            and node.get("y", "0") in ("0", "0px")
                            and node.get("width") == "100%"
                            and node.get("height") == "100%"
                        )
                        if full_bleed:
                            node.set("data-drop", "1")
                        elif attr == "fill":
                            computed["fill"] = "#ffffff"
                        else:
                            node.attrib.pop("stroke", None)
                            computed.pop("stroke", None)

        is_text = local(node.tag) in ("text", "tspan")
        for prop, value in computed.items():
            if prop.startswith("--") or prop not in TARGET:
                continue
            if prop in TEXT_PROPS and not is_text:
                continue
            if prop in ("fill", "stroke", "stop-color"):
                if value == "currentColor":
                    value = computed.get("color") or inherited.get("color") or "#1f2329"
                color, alpha = normalize_color(value, palette)
                if color is None:
                    continue
                node.set(prop, color)
                if alpha is not None:
                    node.set(prop + "-opacity", f"{alpha:g}")
                continue
            if prop == "fill-opacity" and value.endswith("%"):
                value = str(float(value[:-1]) / 100)
            node.set(prop, value)

        next_inherited = dict(inherited)
        for prop in INHERITED:
            if prop in computed:
                next_inherited[prop] = computed[prop]
        node.attrib.pop("class", None)
        node.attrib.pop("style", None)
        for child in list(node):
            walk(child, ancestors + [node], next_inherited)

    walk(root, [], {})

    for node in root.iter():
        for attr in COLOR_ATTRS:
            value = node.get(attr)
            if not value or value == "none" or value.startswith("url("):
                continue
            color, alpha = normalize_color(value, palette)
            if color is None:
                continue
            node.set(attr, color)
            if alpha is not None:
                node.set(attr + "-opacity", f"{alpha:g}")

    for parent in list(root.iter()):
        for child in list(parent):
            if local(child.tag) in DROP_TAGS or child.get("data-drop") == "1":
                parent.remove(child)
                continue
            child.attrib.pop("data-drop", None)
    for node in root.iter():
        for attr in ("class", "style", "clip-path", "mask", "filter"):
            node.attrib.pop(attr, None)

    warnings = check_external(root)
    tree.write(target, encoding="utf-8", xml_declaration=True)
    print(f"larkify: wrote {target}")
    for warning in warnings:
        print(f"larkify: warning: {warning}", file=sys.stderr)
    return warnings


def main() -> None:
    parser = argparse.ArgumentParser(description="Inline SVG CSS and map diagram-design colors to the Lark palette.")
    parser.add_argument("input", help="source SVG exported by diagram-design")
    parser.add_argument("output", nargs="?", help="target SVG; default <input>.lark.svg")
    parser.add_argument("--palette", help="JSON map of source colors to Lark colors")
    args = parser.parse_args()
    output = args.output or re.sub(r"\.svg$", "", args.input) + ".lark.svg"
    convert(args.input, output, args.palette)


if __name__ == "__main__":
    main()
