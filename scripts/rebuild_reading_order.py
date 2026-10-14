"""按 OCR 的坐标重建阅读顺序 —— 解决双栏/页边批注排版被"行序"打乱的问题。

═══ 问题（实测）═══
这道资料是**双栏 / 页边批注**排版，而 ``ocr_pages.py`` 是把每页的行**按 OCR 返回顺序**
用 ``"\\n".join()`` 拼起来的。结果批注行与正文行交错，例如 Q9：

    （对策有误）
    A选项谈论的是"相声创作"的问题、B选项谈论的是"相声表演形式"的问题…
    A选项、B选项问题、对策均不正确，排除；…

选项字母与它的评注被拆到了相隔很远的行上，逐行正则抓不住。
**但信息是存在的** —— rapidocr 返回了每行的 ``box``（四个角点坐标）。

═══ 做法 ═══
1. 读一页的所有行及其 box，算每行的 (x_left, y_center, x_right)。
2. 判栏：把所有行的 x_left 聚类。若存在明显的两簇 → 双栏；否则单栏。
3. 按"先栏、后纵向"排序：
   - 单栏：按 y_center 升序。
   - 双栏：先按栏号，再按 y_center。
4. 把**同一栏内纵向相邻**的行合并成行（y 间距小于半个行高 → 同一视觉行），
   这样栏内被切成两半的句子能接回去。

⚠ 这是**实验**：它可能变好也可能变坏（版面探测很容易过拟合一份资料）。
所以本脚本**不直接改 ocr_pages.py**，而是产出对照文本，
让人/脚本比较"行序版"与"坐标序版"哪个更能让选项评注被解析出来。

用法: D:\\miniconda\\python.exe scripts\\rebuild_reading_order.py --ocr <解析OCR目录> --page 4 --compare
"""

import argparse
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def line_metrics(line):
    """从一行的 box 算出 (x_left, x_right, y_center, height)。"""
    box = line.get("box")
    if not box:
        return None
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    return {
        "x_left": min(xs),
        "x_right": max(xs),
        "y_center": sum(ys) / len(ys),
        "height": max(1.0, max(ys) - min(ys)),
        "text": line.get("text", ""),
    }


def detect_columns(metrics, page_width, gap_ratio=0.12):
    """判断有几栏。

    做法：看每行左边界的位置分布。双栏版面上，右栏的行左边界会明显大于左栏。
    用"是否存在一个宽度为 page_width*gap_ratio 的空隙把行分成两组"来判。
    """
    if not metrics:
        return 1, None
    lefts = sorted(m["x_left"] for m in metrics)
    # 找最大的相邻间隔
    best_gap, best_at = 0.0, None
    for a, b in zip(lefts, lefts[1:]):
        if b - a > best_gap:
            best_gap, best_at = b - a, (a + b) / 2
    if best_at is not None and best_gap > page_width * gap_ratio:
        return 2, best_at
    return 1, None


def rebuild(page_payload, merge_tolerance=0.6):
    """重建一页的阅读顺序，返回 (文本, 诊断)。"""
    lines = [line_metrics(l) for l in page_payload.get("lines", [])]
    lines = [m for m in lines if m]
    if not lines:
        return "", {"lines": 0, "columns": 0}

    page_width = max(m["x_right"] for m in lines)
    cols, split_x = detect_columns(lines, page_width)

    if cols == 2 and split_x is not None:
        groups = [[m for m in lines if m["x_left"] < split_x], [m for m in lines if m["x_left"] >= split_x]]
        # 栏内按 y 排（页边批注栏可能在左也可能在右，这两组都覆盖）
        ordered = []
        for g in groups:
            ordered.extend(sorted(g, key=lambda m: m["y_center"]))
        note = f"2-column split at x={split_x:.0f}"
    else:
        ordered = sorted(lines, key=lambda m: m["y_center"])
        note = "single column"

    # 合并纵向相邻的行：栏内被切成两半的句子接回去
    merged = []
    for m in ordered:
        if merged and abs(m["y_center"] - merged[-1]["y_center"]) < m["height"] * merge_tolerance:
            merged[-1]["text"] += m["text"]
            merged[-1]["y_center"] = (merged[-1]["y_center"] + m["y_center"]) / 2
        else:
            merged.append(dict(m))

    text = "\n".join(m["text"] for m in merged)
    return text, {"lines": len(lines), "merged": len(merged), "columns": cols, "note": note}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ocr", required=True)
    ap.add_argument("--page", type=int, default=0)
    ap.add_argument("--compare", action="store_true", help="对照：行序版 vs 坐标序版")
    ap.add_argument("--out-dir", help="把重建后的每页文本写到这个目录（每页一个 .txt）")
    args = ap.parse_args()

    files = sorted(
        f for f in os.listdir(args.ocr) if f.endswith(".json") and not f.startswith("_")
    )

    if args.out_dir:
        os.makedirs(args.out_dir, exist_ok=True)
        total = 0
        diag = []
        for name in files:
            with open(os.path.join(args.ocr, name), encoding="utf-8") as fh:
                p = json.load(fh)
            text, d = rebuild(p)
            with open(os.path.join(args.out_dir, name.replace(".json", ".txt")), "w", encoding="utf-8") as fh:
                fh.write(text)
            diag.append({"page": p.get("page"), **d})
            total += 1
        with open(os.path.join(args.out_dir, "_diag.json"), "w", encoding="utf-8") as fh:
            json.dump(diag, fh, ensure_ascii=False, indent=2)
        print(f"rebuilt {total} pages -> {args.out_dir}")
        from collections import Counter

        print("columns dist:", dict(Counter(d["columns"] for d in diag)))
        return 0

    if not args.page:
        print("--page 或 --out-dir 至少给一个")
        return 2

    target = None
    for name in files:
        with open(os.path.join(args.ocr, name), encoding="utf-8") as fh:
            p = json.load(fh)
        if p.get("page") == args.page:
            target = p
            break
    if target is None:
        print(f"page {args.page} not found")
        return 2

    text, d = rebuild(target)
    print(f"page {args.page}  diagnostics={d}")
    print("=" * 74)
    print(text)
    if args.compare:
        print("=" * 74)
        print("ORIGINAL (line order):")
        print(target.get("text", ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
