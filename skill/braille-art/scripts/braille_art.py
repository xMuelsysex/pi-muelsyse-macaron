#!/usr/bin/env python3
"""字符画工具链：位图 → Braille 单元 + 真彩色 ANSI，外加预览与精修校验。

三种模式：
  convert  <源图>                    位图转字符画，产出 <out>.txt / <out>.ansi / <out>.png
  render   --render <字符画>         已有点阵重新渲染预览 PNG（精修后同步预览用）
  verify   --verify <新> --against <旧>   精修前后比对：尺寸、mask 外逐点、去色文本

依赖 Pillow；预览默认用 fc-match 找到的 Braille 字体，取不到时用 --font 指定或 --dots 画方块点。
"""
from __future__ import annotations

import argparse
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import cast

from PIL import Image, ImageDraw, ImageFont

# 8 点单元：(bit, dx, dy)，dx=0 左列、dy=0 顶部；与终端 Braille 点序 1-8 一致。
DOTS = (
    (0x01, 0, 0), (0x02, 0, 1), (0x04, 0, 2), (0x40, 0, 3),
    (0x08, 1, 0), (0x10, 1, 1), (0x20, 1, 2), (0x80, 1, 3),
)
BLANK = "\u2800"
CELL_PATTERN = re.compile(r"\x1b\[38;2;(\d+);(\d+);(\d+)m(.)")
SGR_PATTERN = re.compile(r"\x1b\[[0-9;]*m")
DEFAULT_FROM = (242, 167, 198)   # 缪尔赛思粉
DEFAULT_TO = (159, 211, 242)     # 天空蓝
PREVIEW_BG = (25, 27, 37)
DEFAULT_FONT_QUERY = "Maple Mono NF CN"


def parse_rgb(text: str) -> tuple[int, int, int]:
    value = text.strip().lstrip("#")
    if len(value) == 6:
        try:
            return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))
        except ValueError:
            pass
    else:
        parts = value.split(",")
        if len(parts) == 3 and all(p.strip().isdigit() and 0 <= int(p) <= 255 for p in parts):
            return (int(parts[0]), int(parts[1]), int(parts[2]))
    raise argparse.ArgumentTypeError(f"颜色需要 #RRGGBB 或 r,g,b：{text}")


def parse_cell(text: str) -> tuple[int, int]:
    parts = text.lower().split("x")
    if len(parts) != 2 or not all(p.isdigit() and int(p) > 0 for p in parts):
        raise argparse.ArgumentTypeError(f"单元尺寸需要 WxH：{text}")
    return (int(parts[0]), int(parts[1]))


def parse_mask(text: str, cols: int, rows: int) -> tuple[int, int, int, int]:
    parts = text.split(",")
    if len(parts) != 4:
        raise ValueError(f"--mask 需要 X0,Y0,X1,Y1：{text}")
    x0, y0, x1, y1 = (int(p) for p in parts)
    if not (0 <= x0 < x1 <= cols and 0 <= y0 < y1 <= rows):
        raise ValueError(f"--mask 越界或为空（网格 {cols}x{rows}）：{text}")
    return (x0, y0, x1, y1)


def half_up(value: float) -> int:
    """JS Math.round 的口径，Python round() 的银行家舍入会与既有产物不一致。"""
    return math.floor(value + 0.5)


# ---------------------------------------------------------------------------
# convert
# ---------------------------------------------------------------------------

def fit_image(image: Image.Image, width: int, height: int, mode: str) -> Image.Image:
    if mode == "stretch":
        return image.resize((width, height), Image.Resampling.LANCZOS)
    w, h = image.size
    scale = min(width / w, height / h) if mode == "contain" else max(width / w, height / h)
    resized = image.resize((max(1, half_up(w * scale)), max(1, half_up(h * scale))), Image.Resampling.LANCZOS)
    canvas = Image.new(image.mode, (width, height), 0 if image.mode == "L" else (0, 0, 0))
    canvas.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    return canvas


def apply_gamma(luma: Image.Image, gamma: float) -> Image.Image:
    if gamma == 1.0:
        return luma
    table = [min(255, half_up(255 * (i / 255) ** gamma)) for i in range(256)]
    return luma.point(table)


def otsu_threshold(luma: Image.Image) -> int:
    histogram = luma.histogram()
    total = sum(histogram)
    sum_all = sum(level * count for level, count in enumerate(histogram))
    sum_back = 0.0
    weight_back = 0
    best_threshold, best_variance = 0, -1.0
    for level in range(256):
        weight_back += histogram[level]
        if weight_back == 0:
            continue
        weight_fore = total - weight_back
        if weight_fore == 0:
            break
        sum_back += level * histogram[level]
        mean_back = sum_back / weight_back
        mean_fore = (sum_all - sum_back) / weight_fore
        variance = weight_back * weight_fore * (mean_back - mean_fore) ** 2
        if variance > best_variance:
            best_variance, best_threshold = variance, level
    return best_threshold


def ink_matrix(luma: Image.Image, threshold: int, dither: bool) -> list[list[bool]]:
    width, height = luma.size
    samples = luma.tobytes()  # 模式 "L"：每像素一字节
    if not dither:
        return [[samples[y * width + x] >= threshold for x in range(width)] for y in range(height)]
    pixels = [[float(samples[y * width + x]) for x in range(width)] for y in range(height)]
    ink = [[False] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            old = pixels[y][x]
            new = 255.0 if old >= threshold else 0.0
            ink[y][x] = new > 0.0
            error = old - new
            for dx, dy, weight in ((1, 0, 7 / 16), (-1, 1, 3 / 16), (0, 1, 5 / 16), (1, 1, 1 / 16)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height:
                    pixels[ny][nx] += error * weight
    return ink


def to_cells(ink: list[list[bool]], cols: int, rows: int) -> list[list[int]]:
    return [
        [
            sum(bit for bit, dx, dy in DOTS if ink[cy * 4 + dy][cx * 2 + dx])
            for cx in range(cols)
        ]
        for cy in range(rows)
    ]


def gradient_columns(cols: int, start: tuple[int, int, int], end: tuple[int, int, int]) -> list[tuple[int, int, int]]:
    """与 extensions/header/index.ts 的 gradient() 同式：t = x / (cols - 1)，半进位。"""
    span = max(1, cols - 1)
    colors: list[tuple[int, int, int]] = []
    for x in range(cols):
        t = x / span
        colors.append((
            half_up(start[0] + (end[0] - start[0]) * t),
            half_up(start[1] + (end[1] - start[1]) * t),
            half_up(start[2] + (end[2] - start[2]) * t),
        ))
    return colors


def sampled_cells(rgb: Image.Image, cols: int, rows: int) -> list[list[tuple[int, int, int]]]:
    """每个单元取源图对应 2x4 块的均色；源图已归一到 (cols*2, rows*4)，BOX 采样即块均值。"""
    data = rgb.resize((cols, rows), Image.Resampling.BOX).tobytes()  # RGB：每像素 3 字节
    return [
        [(data[(y * cols + x) * 3], data[(y * cols + x) * 3 + 1], data[(y * cols + x) * 3 + 2]) for x in range(cols)]
        for y in range(rows)
    ]


def encode(cells: list[list[int]], colors: list[list[tuple[int, int, int]]] | None) -> str:
    lines = []
    for y, row in enumerate(cells):
        if colors is None:
            lines.append("".join(chr(0x2800 + bits) for bits in row))
            continue
        body = []
        for x, bits in enumerate(row):
            r, g, b = colors[y][x]
            body.append(f"\x1b[38;2;{r};{g};{b}m{chr(0x2800 + bits)}")
        lines.append("".join(body) + "\x1b[0m")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# 点阵解析 / 预览
# ---------------------------------------------------------------------------

def parse_cells(path: Path) -> tuple[list[list[tuple[str, tuple[int, int, int] | None]]], bool]:
    """解析字符画，返回 (单元网格, 是否带色)；一份文件要么全带色，要么全不带色。"""
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.rstrip("\n").split("\n")
    colored = [bool(CELL_PATTERN.findall(line)) for line in lines]
    if any(colored) and not all(colored):
        raise SystemExit(f"{path} 混有彩色行与无色行，先把颜色统一。")
    grid: list[list[tuple[str, tuple[int, int, int] | None]]] = []
    for line, has_color in zip(lines, colored):
        grid.append(
            [(char, (int(r), int(g), int(b))) for r, g, b, char in CELL_PATTERN.findall(line)]
            if has_color else [(char, None) for char in SGR_PATTERN.sub("", line)]
        )
    return grid, any(colored)


def resolve_font(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    if not shutil.which("fc-match"):
        return None
    result = subprocess.run(["fc-match", "-f", "%{file}", DEFAULT_FONT_QUERY],
                            capture_output=True, text=True, check=False)
    path = result.stdout.strip()
    return path if path and Path(path).exists() else None


def render_preview(
    cells: list[list[int]], colors: list[list[tuple[int, int, int]]],
    cell: tuple[int, int], bg: tuple[int, int, int], font_path: str | None, dots: bool,
) -> Image.Image:
    cell_w, cell_h = cell
    rows, cols = len(cells), len(cells[0])
    image = Image.new("RGB", (cols * cell_w, rows * cell_h), bg)
    draw = ImageDraw.Draw(image)
    font = None
    if not dots:
        if font_path is None:
            raise SystemExit("预览需要 Braille 字体：装一个、用 --font 指定字体文件，或用 --dots 画方块点。")
        probe = ImageFont.truetype(font_path, 100)
        font = ImageFont.truetype(font_path, max(1, half_up(cell_w / (probe.getlength(BLANK) / 100))))
    for y, row in enumerate(cells):
        for x, bits in enumerate(row):
            color = colors[y][x]
            if font is not None:
                draw.text((x * cell_w, y * cell_h), chr(0x2800 + bits), font=font, fill=color)
                continue
            for bit, dx, dy in DOTS:
                if not bits & bit:
                    continue
                x0 = x * cell_w + dx * (cell_w // 2)
                y0 = y * cell_h + dy * (cell_h // 4)
                draw.rectangle((x0, y0, x0 + cell_w // 2 - 1, y0 + cell_h // 4 - 1), fill=color)
    return image


# ---------------------------------------------------------------------------
# 模式实现
# ---------------------------------------------------------------------------

def run_convert(args: argparse.Namespace) -> int:
    source_path = Path(args.source).expanduser()
    if not source_path.is_file():
        raise SystemExit(f"找不到源图：{source_path}")
    cols, rows = args.cols, args.rows
    if cols < 1 or rows < 1:
        raise SystemExit("--cols/--rows 必须为正整数")
    dot_w, dot_h = cols * 2, rows * 4

    source = Image.open(source_path).convert("RGB")
    luma = apply_gamma(fit_image(source.convert("L"), dot_w, dot_h, args.fit), args.gamma)
    threshold = otsu_threshold(luma) if args.threshold == "auto" else int(args.threshold)
    if not 0 <= threshold <= 255:
        raise SystemExit("--threshold 需要在 0-255 之间，或写 auto")
    ink = ink_matrix(luma, threshold, args.dither)
    if args.invert:
        ink = [[not value for value in row] for row in ink]
    cells = to_cells(ink, cols, rows)
    if args.color == "source":
        colors = sampled_cells(fit_image(source, dot_w, dot_h, args.fit), cols, rows)
    elif args.color == "gradient":
        columns = gradient_columns(cols, args.start, args.end)
        colors = [list(columns) for _ in range(rows)]
    else:
        colors = None

    prefix = Path(args.out).expanduser() if args.out else Path.cwd() / f"{source_path.stem}-{cols}x{rows}"
    prefix.parent.mkdir(parents=True, exist_ok=True)
    (prefix.with_suffix(".txt")).write_text(encode(cells, None), encoding="utf-8")
    written = [f"{prefix}.txt"]
    if colors is None:
        print(f"未写 {prefix}.ansi（--color none）；同名前缀若有旧 .ansi，请自行处理以保持三件套同步。")
    else:
        prefix.with_suffix(".ansi").write_text(encode(cells, colors), encoding="utf-8")
        written.append(f"{prefix}.ansi")
    if not args.no_png:
        preview_colors = colors if colors else [gradient_columns(cols, args.start, args.end)] * rows
        preview = render_preview(cells, preview_colors, args.cell, args.bg,
                                 None if args.dots else resolve_font(args.font), args.dots)
        preview.save(prefix.with_suffix(".png"))
        written.append(f"{prefix}.png (单元 {args.cell[0]}x{args.cell[1]}px)")

    inked = sum(bin(bits).count("1") for row in cells for bits in row)
    print(f"网格 {cols}x{rows} 单元（{dot_w}x{dot_h} 点） · 颜色 {args.color} · 阈值 {threshold}"
          f"{'（Otsu）' if args.threshold == 'auto' else ''}{' · 抖动' if args.dither else ''}"
          f"{' · 反转' if args.invert else ''}")
    print(f"点亮 {inked} / {dot_w * dot_h} 点（{inked / (dot_w * dot_h) * 100:.1f}%）")
    for path in written:
        print(f"写出 {path}")
    return 0


def run_render(args: argparse.Namespace) -> int:
    art = Path(args.render).expanduser()
    if not art.is_file():
        raise SystemExit(f"找不到字符画：{art}")
    grid, colored = parse_cells(art)
    if not grid or not grid[0]:
        raise SystemExit(f"字符画为空：{art}")
    cells = [[ord(char) - 0x2800 for char, _ in row] for row in grid]
    if colored:
        colors = cast(list[list[tuple[int, int, int]]], [[color for _, color in row] for row in grid])
    else:
        print("输入无颜色，预览按 --from/--to 端色上色。")
        gradient = gradient_columns(len(cells[0]), args.start, args.end)
        colors = [[gradient[x] for x in range(len(row))] for row in cells]
    out = Path(args.out).expanduser() if args.out else art.with_suffix(".png")
    render_preview(cells, colors, args.cell, args.bg, None if args.dots else resolve_font(args.font), args.dots).save(out)
    print(f"渲染 {art}（{len(cells)}x{len(cells[0])} 单元） → {out}，单元 {args.cell[0]}x{args.cell[1]}px")
    return 0


def run_verify(args: argparse.Namespace) -> int:
    new_path, old_path = Path(args.verify).expanduser(), Path(args.against).expanduser()
    for path in (new_path, old_path):
        if not path.is_file():
            raise SystemExit(f"找不到文件：{path}")
    new, _ = parse_cells(new_path)
    old, _ = parse_cells(old_path)
    problems: list[str] = []
    if len(new) != len(old) or len(new[0]) != len(old[0]):
        problems.append(f"尺寸不一致：{len(old)}x{len(old[0])} → {len(new)}x{len(new[0])}")
    else:
        rows, cols = len(old), len(old[0])
        mask = parse_mask(args.mask, cols, rows) if args.mask else None
        changed = outside = 0
        for y in range(rows):
            for x in range(cols):
                if new[y][x] == old[y][x]:
                    continue
                changed += 1
                if mask is None or not (mask[0] <= x < mask[2] and mask[1] <= y < mask[3]):
                    outside += 1
        print(f"变化单元 {changed} / {rows * cols}"
              + (f"，其中 mask 外 {outside}" if mask else "（未给 --mask，全部按 mask 外计）"))
        if outside:
            problems.append(f"mask 外有 {outside} 个单元变化")
    if args.txt:
        txt_path = Path(args.txt).expanduser()
        plain = "\n".join("".join(char for char, _ in row) for row in new) + "\n"
        if txt_path.read_text(encoding="utf-8") != plain:
            problems.append(f"去色文本与 {txt_path} 不一致")
        else:
            print(f"去色文本与 {txt_path} 一致")
    if problems:
        for problem in problems:
            print(f"不一致：{problem}", file=sys.stderr)
        return 1
    print("校验通过")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", nargs="?", help="源图路径（convert 模式）")
    parser.add_argument("--render", metavar="ART", help="渲染已有 .ansi/.txt 为预览 PNG")
    parser.add_argument("--verify", metavar="NEW", help="精修后的字符画")
    parser.add_argument("--against", metavar="OLD", help="精修前的字符画")
    parser.add_argument("--mask", metavar="X0,Y0,X1,Y1", help="verify：允许变化的单元矩形（右下开区间）")
    parser.add_argument("--txt", metavar="FILE", help="verify：比对的去色 .txt")
    parser.add_argument("--cols", type=int, default=72, help="单元列数（默认 72，Pi 页眉默认宽度）")
    parser.add_argument("--rows", type=int, default=9, help="单元行数（默认 9）")
    parser.add_argument("--color", choices=("gradient", "source", "none"), default="gradient",
                        help="gradient 按列渐变（默认）／source 取源图块均色／none 只出纯文本")
    parser.add_argument("--from", dest="start", type=parse_rgb, default=DEFAULT_FROM,
                        help="渐变起始色（默认 #F2A7C6）")
    parser.add_argument("--to", dest="end", type=parse_rgb, default=DEFAULT_TO,
                        help="渐变结束色（默认 #9FD3F2）")
    parser.add_argument("--threshold", default="auto", help="二值化阈值 0-255，或 auto（默认 Otsu）")
    parser.add_argument("--gamma", type=float, default=1.0, help="二值化前的亮度 gamma")
    parser.add_argument("--invert", action="store_true", help="反转墨点（亮底暗墨的源图）")
    parser.add_argument("--dither", action="store_true", help="Floyd–Steinberg 抖动")
    parser.add_argument("--fit", choices=("contain", "cover", "stretch"), default="contain",
                        help="源图放进点阵的方式（默认 contain，等比留黑边）")
    parser.add_argument("--out", metavar="PREFIX", help="产物前缀，convert 默认 <源图名>-<cols>x<rows>")
    parser.add_argument("--no-png", action="store_true", help="convert 不生成预览 PNG")
    parser.add_argument("--dots", action="store_true", help="预览画方块点，不需要 Braille 字体")
    parser.add_argument("--font", metavar="PATH", help="预览字体文件（默认 fc-match Maple Mono NF CN）")
    parser.add_argument("--cell", type=parse_cell, default=(12, 24), metavar="WxH",
                        help="预览单元像素尺寸（默认 12x24）")
    parser.add_argument("--bg", type=parse_rgb, default=PREVIEW_BG, help="预览背景色（默认 #191B25）")
    args = parser.parse_args(argv)

    modes = [bool(args.source), bool(args.render), bool(args.verify)]
    if sum(modes) != 1:
        parser.error("三种模式选一个：<源图> / --render / --verify")
    if args.verify and not args.against:
        parser.error("--verify 需要配合 --against")
    if args.render:
        return run_render(args)
    if args.verify:
        return run_verify(args)
    return run_convert(args)


if __name__ == "__main__":
    sys.exit(main())
