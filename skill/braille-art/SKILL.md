---
name: braille-art
description: 把位图做成终端字符画（Braille 单元 + 真彩色 ANSI），生成 .txt/.ansi/.png 三件套、出预览、接到 Pi 页眉，并在精修后校验不变量。当用户提到"字符画 / 字符艺术 / ASCII 画 / ANSI 图 / 点阵图 / Braille 画 / 页眉图 / 把这张图转成字符画"，或要替换、精修 Pi 页眉图案时使用。
---

# 终端字符画（Braille + 真彩色）

**命令一律用与本文件同级的脚本**：`python3 scripts/braille_art.py`（路径相对本 skill 目录，即 `SKILL.md` 所在目录；在别处调用时加上该目录前缀）。依赖 Pillow；预览默认用 `fc-match` 找到的 Braille 字体。

## 单元与产物

- 一个单元 = **2×4 点** = 一个 Braille 字符（U+2800 起，空单元写 `⠀`）；点阵分辨率 = `2×cols × 4×rows`。
- 产物三件套，缺一不可：
  - `.txt` 去色点阵（与 `.ansi` 去色后逐字符一致）；
  - `.ansi` 每单元一个 `\x1b[38;2;r;g;bm`，每行以 `\x1b[0m` 收尾；
  - `.png` 预览（人眼验收用）。
- 常用尺寸：**页眉 72×9**、立绘 96×48 单元；预览单元 12×24 px、背景 `#191B25`。
- 配色两味：`--color gradient` 按列 `#F2A7C6 → #9FD3F2`（与 `extensions/header/index.ts` 的 `gradient()` 同式：`t = x/(cols-1)`，半进位）；`--color source` 取源图 2×4 块均色。

## 生成

```bash
python3 scripts/braille_art.py portrait.png --cols 72 --rows 9 --out header
# 写出 header.txt / header.ansi / header.png，并打印网格、阈值与点亮比例
```

**先定源图，再调参数。** 字符画只保留一层"墨点"，源图必须主体与背景明暗分离（本项目的源图就是深背景 + 亮主体的立绘裁剪）：

- 主体比背景亮 → 直接跑；主体比背景暗 → `--invert`。
- 背景花、主体与环境亮度接近 → 先在源图上裁到主体、压暗背景，否则网格里只会得到噪点。
- 判定标准就是 `.png` 预览：**主体应当是点亮的那一层**，不是背景。

调参顺序（每改一次就看 `.png`）：

| 参数 | 用法 |
|------|------|
| `--threshold auto\|0-255` | 默认 `auto`（Otsu）；细节糊/断线时手动压 |
| `--gamma 1.0` | 压暗部或提亮部后再二值化 |
| `--dither` | 大面积渐变处补层次（Floyd–Steinberg）；细节密的插画会变噪点，慎用 |
| `--invert` | 墨点换到暗处（主体比背景暗时用） |
| `--fit contain\|cover\|stretch` | 留黑边（默认）／裁满／拉伸 |
| `--color gradient\|source\|none` | 单色渐变／原色／只出纯文本 |

## 接到 Pi 页眉

- 默认图：把 `.ansi` 内容放进 `extensions/header/muelsyse-header.ansi`（随包分发，改后需重跑本仓验证）。
- 临时换图：`/muelsyse-art <path>`（运行时加载，不动包；`/muelsyse-art reset` 还原）。
- 标题：`/muelsyse-header "<text>"`（写入 `~/.pi/agent/muelsyse-macaron-header.json`；`reset` 删文件恢复默认）。

## 运行时约束（页眉 `readArtwork` 会拒收的情形）

- **只允许文本 + SGR**：制表符与其它 C0/C1 控制字符（含光标控制序列）直接报错 → 制表符统一换空格。
- 严格 UTF-8；CRLF 归一；结尾空行去掉；整图为空则报错。
- 超宽**从右侧裁剪**、高度保留 → 图要紧凑，可视宽度由列数决定。
- `NO_COLOR` 下 SGR 被剥离，只剩点阵文本 → 纯文本形态也要能看。
- Braille 都是窄字符：**单元数 = 终端列数**，72×9 在 80 列终端留 8 列余量。

## 精修与校验

改已有 `.ansi` 的点位（局部修轮廓、补指缝之类）后：

```bash
python3 scripts/braille_art.py --render header.ansi --out header.png   # 重出预览
python3 scripts/braille_art.py --verify header.ansi \
        --against header.old.ansi --mask 38,2,43,5 --txt header.txt      # 校验不变量
```

`--mask X0,Y0,X1,Y1` 是允许变化的单元矩形（右下开区间）；不给就要求逐点全等。校验项：尺寸不变、mask 外逐点（字符 + 颜色）一致、去色文本与 `.txt` 一致。**三件套必须同步更新**。

## 验收清单

1. 每行单元数 == `--cols`；行尾 `\x1b[0m`；行数 == `--rows`；`.txt` == `.ansi` 去色。
2. `gradient` 模式每列同色，且等于 `floor(from + (to-from)·x/(cols-1) + 0.5)`。
3. 宿主侧：在本项目仓库跑
   `PI_HOST_ROOT=/home/muelsyse/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent node --experimental-transform-types --no-warnings --import ./test/register.mjs <脚本>`
   把点阵喂给 `renderHeader(width, art)`，1–200 列宽都不溢出。
4. 人眼：看 `.png` 预览确认脸/手等关键部位没糊。

## 别做的事

- 不要用 `chafa` / `img2txt` 现成输出直接当页眉图：chafa 会写光标控制序列（实测 `\x1b[?25l`），页眉 `readArtwork` 去掉 SGR 后仍见控制字符，**直接拒收**；img2txt 虽然只剩 SGR，但会写背景色与闪烁属性、用块字符且行长不齐，不符合本项目的点阵约定。
- 不要把制表符、超长行（超过目标列数）或带光标控制的文本塞进点阵。
- 预览字体取不到时不要静默换形：显式用 `--font <字体文件>` 或 `--dots`（方块点）。
