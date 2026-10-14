"""用"行首孤立标点"找下划线型空位 —— 空位的第二种形态。

═══ 两种空位，两种信号 ═══
实测这道资料里的空位有两种，**必须分别处理**：

  ① **留白型**（`find_blanks_by_geometry.py` 处理）
     空位是一段空白，正文为它空出一行 → **行距异常**。
     实测 q4：前一行"…因此"，后一行"填入文中画横线部分…"，中间间距 81 vs 常规 39.5。

  ② **下划线型**（本脚本处理）
     空位是被划掉的一行字。下划线画在字的**下面**，**行距不变** —— 几何法抓不到。
     但 OCR 会露出马脚：被划掉那行的末尾标点会**掉到下一行行首**，形成一个孤立标点。
     实测 q18：
         前一行: …两侧的固体燃料推进器。      ← 句号在行末（这一行是完整的）
         后一行: 。火箭是非常复杂的东西…      ← 行首一个孤立句号
     那个孤立的"。"就是**空位之后的正文起点**——真正的接续点在它前面。

═══ 为什么这个信号可信 ═══
中文正文**不会**以句号/逗号/顿号开头。所以"行首孤立标点"是排版异常的确证，
而不是噪声——这也是它比"行距异常"更可靠的原因（后者会被段落间距、插图等干扰）。

═══ 边界 ═══
它只能定位到"空位在某行之前"，不能给出空位的**范围**（几行）。
所以产出的是"插入点提示"，不是精确切片。这足够解决"不知道空位在哪"的问题。

用法: D:\\miniconda\\python.exe scripts\\find_blanks_by_punctuation.py --ocr <题本OCR目录> --bank <题库文件>
"""

import argparse
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

# 中文正文不会以这些字符开头。
# ⚠ 必须把**全角中文标点**列全：第一版漏了 `。`（U+3002 全角句号），
#   而原文行首孤立标点恰恰就是它 —— 于是检测器全页 0 命中。
#   ASCII 的 `.` 与全角 `。` 是两个不同字符，混用会静默漏检。
LEADING_PUNCT = "。，、；：？！）】》”’…—·,.;:?!)]}"

# 但有些是**正当**的行首符号，必须排除——否则会满屏误报。
#
# ⚠ 这里踩过一个自伤的坑：第一版把 `.` 和 `)` 也放进了"正当行首"里，
# 于是"行首是句号"这个**正是要找的信号**被自己排除了，检测器输出 0 命中。
# 教训：排除清单只能列**真的是正当**的开头（选项标签、序号、括号、引号），
# 不能图省事把标点整类塞进去——那等于把要检的东西排除掉。
OK_LINE_START = re.compile(r"^\s*([A-DＡ-Ｄ]\s*[.．、]|\d+\s*[.．、]|[（(【\[]|[\"'“‘])")


def load_pages(ocr_dir):
    pages = []
    for name in sorted(os.listdir(ocr_dir)):
        if not name.endswith(".json") or name.startswith("_"):
            continue
        with open(os.path.join(ocr_dir, name), encoding="utf-8") as fh:
            p = json.load(fh)
        lines = []
        for ln in p.get("lines", []):
            box = ln.get("box")
            if not box:
                continue
            ys = [pt[1] for pt in box]
            xs = [pt[0] for pt in box]
            lines.append({"text": ln.get("text", ""), "y": sum(ys) / len(ys), "x_left": min(xs), "x_right": max(xs)})
        lines.sort(key=lambda l: l["y"])
        pages.append({"page": p.get("page"), "lines": lines})
    pages.sort(key=lambda p: p["page"] or 0)
    return pages


def find_leading_punct(lines):
    """找行首孤立标点。

    ═══ 关键：重复标点才是信号，不是噪声 ═══
    第一版里我写了这条"确认"：

        if prev.endswith(t[0]): continue      # ← 错的

    当时的想法是"前后两行以同一个标点相接，说明 OCR 把一行切成了两半，不是空位"。
    **语义正好反了。** 实测 q18：

        前一行: …两侧的固体燃料推进器用的也是改进过的航天飞机的固体燃料推进器。
        后一行: 。火箭是非常复杂的东西，…       ← 行首一个孤立句号

    前一行**已经**以句号结束了（那句话是完整的），后一行却**又**以一个句号开头——
    多出来的那个句号，是被划掉那一行（下划线空位）末尾的标点掉了下来。
    所以「前一行以 X 结尾 且 后一行以 X 开头」= **中间少了一行**，正是要找的东西。

    返回 [{idx, text, prev_text, char, duplicated}]。
    """
    hits = []
    for i, ln in enumerate(lines):
        t = ln["text"].lstrip()
        if not t:
            continue
        if OK_LINE_START.match(t):
            continue
        if t[0] not in LEADING_PUNCT:
            continue
        prev = lines[i - 1]["text"].rstrip() if i > 0 else ""
        duplicated = prev.endswith(t[0])
        hits.append(
            {
                "idx": i,
                "text": t,
                "prev_text": prev,
                "char": t[0],
                "duplicated": duplicated,
                "y": ln["y"],
                "x_left": ln["x_left"],
            }
        )
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ocr", required=True)
    ap.add_argument("--bank")
    ap.add_argument("--page", type=int, default=0, help="只报某页的原始命中（不给题库时用）")
    args = ap.parse_args()

    pages = load_pages(args.ocr)

    if not args.bank:
        targets = [p for p in pages if not args.page or p["page"] == args.page]
        total = 0
        for p in targets:
            hits = find_leading_punct(p["lines"])
            total += len(hits)
            print(f"page {p['page']}: {len(p['lines'])} 行, 行首孤立标点 {len(hits)} 处")
            for h in hits:
                print(f"   前一行尾: …{h['prev_text'][-26:]}")
                print(f"   命中行  : {h['text'][:36]}")
        print(f"\n合计 {total} 处")
        return 0

    with open(args.bank, encoding="utf-8") as fh:
        bank = json.load(fh)

    print(f"题库 {bank.get('title')}  共 {len(bank.get('questions', []))} 道")
    print("=" * 72)

    flagged = 0
    for q in bank["questions"]:
        sp = q["source"].get("page")
        if not sp:
            continue
        # 该题可能跨页；取起始页与下一页
        cand = [p for p in pages if sp <= (p["page"] or 0) <= sp + 1]
        lines = [ln for p in cand for ln in p["lines"]]
        hits = find_leading_punct(lines)
        if not hits:
            continue
        # 只保留落在该题正文范围内的（题号行之后、选项之前）
        head = re.sub(r"\s+", "", q["stem"])[:10]
        flat = [re.sub(r"\s+", "", l["text"]) for l in lines]
        start = next((i for i, t in enumerate(flat) if head and head in t), None)
        if start is None:
            continue
        end = len(lines)
        for i in range(start + 1, len(lines)):
            if re.match(r"^\s*[ABCDＡ-Ｄ]\s*[.．、]", lines[i]["text"]):
                end = i
                break
        inside = [h for h in hits if start < h["idx"] < end]
        if inside:
            flagged += 1
            print(f"★ {q['source']['number']}  找到 {len(inside)} 处疑似下划线空位")
            for h in inside:
                print(f"      前一行尾: …{h['prev_text'][-30:]}")
                print(f"      空位之后: {h['text'][:40]}")

    print()
    print("=" * 72)
    print(f"{flagged} 道题命中了「行首孤立标点」。")
    print("这个信号比行距可靠（中文正文不会以句号开头），但它只给出**插入点**，")
    print("不给出空位的范围。所以用法是：在此处标注「此处有空位」，而不是精确切片。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
