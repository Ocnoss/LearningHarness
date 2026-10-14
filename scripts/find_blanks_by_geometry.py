"""按 OCR 的行坐标找出"空位"在哪 —— 让"填入画横线部分"变成有位置的信息。

═══ 问题 ═══
作者实测："有些填空题不知道横线或者'空'在哪"。

纸质题目的空位通常是**一段下划线或一段留白**。OCR 只认"字"：
  - 下划线可能丢；
  - 留白**必然丢**（那里没有字，也就没有输出）。

于是"填入文中画横线部分"这类题在文本上**看不出空位在哪**——
而这类题恰恰要求学习者知道位置（要判断哪句话能接在这里）。

═══ 可用的线索：行坐标 ═══
`ocr_pages.py` 把每行的 `box`（四个角点）都存进了 JSON。
空位（一行被下划线占掉）会让**相邻两行的垂直间距**明显大于常规行距。
所以"行距异常"就是空位的位置指纹。

═══ 做法 ═══
1. 对每题，取它所占页面的行；算常规行距（取相邻间距的**中位数**，抗离群）。
2. 找出间距 > 常规行距 * 阈值的相邻行对 —— 那就是一个空位。
3. 在该处插入 `【空位】` 标记，并记录页码与坐标，供人核对。

⚠ 这是**启发式**，必须能被验证：所以本脚本同时输出"每道题找到的空位数"，
并把插入位置前后的原文打出来。找错位置会很明显（标记落在句子中间）。

用法: D:\\miniconda\\python.exe scripts\\find_blanks_by_geometry.py --ocr <题本OCR目录> --bank <题库文件> --numbers set1-q4,set1-q17,set1-q18
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


def load_pages(ocr_dir):
    """读 OCR 结果，返回 [{page, lines:[{text,y_center,height,x_left}]}]。"""
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
            lines.append(
                {
                    "text": ln.get("text", ""),
                    "y": sum(ys) / len(ys),
                    "x_left": min(xs),
                    "x_right": max(xs),
                    "h": max(1.0, max(ys) - min(ys)),
                }
            )
        pages.append({"page": p.get("page"), "lines": lines})
    pages.sort(key=lambda p: p["page"] or 0)
    return pages


def typical_pitch(lines):
    """常规行距：相邻行 y 差的中位数。

    用中位数而不是平均数：一份页面里既有正文行距（小）又有空位（大），
    平均数会被空位拉高，于是空位反而"不异常"了。中位数抗这个。
    """
    ys = sorted(ln["y"] for ln in lines)
    deltas = [b - a for a, b in zip(ys, ys[1:]) if b - a > 0.5]
    if not deltas:
        return None
    deltas.sort()
    return deltas[len(deltas) // 2]


def find_gaps(lines, ratio=1.75, min_abs=None):
    """找出行距异常的位置。

    @param ratio 间距 / 常规行距 超过它就视为一个空位。
    @param min_abs 绝对下限：避免行距很小时把噪声当空位。
    """
    pitch = typical_pitch(lines)
    if pitch is None:
        return [], None
    if min_abs is None:
        min_abs = pitch * ratio
    ordered = sorted(lines, key=lambda ln: ln["y"])
    gaps = []
    for a, b in zip(ordered, ordered[1:]):
        d = b["y"] - a["y"]
        if d > max(pitch * ratio, min_abs):
            gaps.append({"after_text": a["text"], "before_text": b["text"], "gap": round(d, 1), "pitch": round(pitch, 1), "y": round((a["y"] + b["y"]) / 2, 1)})
    return gaps, pitch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ocr", required=True, help="题本 OCR 目录")
    ap.add_argument("--bank", required=True)
    ap.add_argument("--numbers", default="", help="只看这些题号，逗号分隔；省略=全部")
    ap.add_argument("--ratio", type=float, default=1.75)
    ap.add_argument("--max-pages", type=int, default=3, help="每题最多看几页")
    args = ap.parse_args()

    pages = load_pages(args.ocr)
    with open(args.bank, encoding="utf-8") as fh:
        bank = json.load(fh)

    wanted = set(x.strip() for x in args.numbers.split(",") if x.strip())
    questions = [q for q in bank["questions"] if not wanted or q["source"]["number"] in wanted]

    print(f"页面 {len(pages)} 页；检查 {len(questions)} 道题；空位判定阈值 行距×{args.ratio}")
    print()

    found_any = 0
    for q in questions:
        start_page = q["source"].get("page")
        if not start_page:
            continue
        # 看上几页（一道题的正文可能跨页）
        candidates = [p for p in pages if start_page <= (p["page"] or 0) < start_page + args.max_pages]
        all_lines = [ln for p in candidates for ln in p["lines"]]

        # 只保留"属于这道题"的行：从题干开头到选项开始
        head = re.sub(r"\s+", "", q["stem"])[:12]
        flat = [re.sub(r"\s+", "", ln["text"]) for ln in all_lines]
        start_idx = None
        for i, t in enumerate(flat):
            if head and head in t:
                start_idx = i
                break
        if start_idx is None:
            print(f"{q['source']['number']}: 在 OCR 里定位不到题干（跳过）")
            continue
        # 截到选项起点（选项行以 A. B. C. D. 开头）
        end_idx = len(all_lines)
        for i in range(start_idx + 1, len(all_lines)):
            if re.match(r"^\s*[ABCD]\s*[.．、]", all_lines[i]["text"]):
                end_idx = i
                break
        body = all_lines[start_idx:end_idx]

        gaps, pitch = find_gaps(body, ratio=args.ratio)
        flag = "★" if gaps else " "
        print(f"{flag} {q['source']['number']}  行数={len(body)}  常规行距={pitch and round(pitch,1)}  找到空位={len(gaps)}")
        for g in gaps[:4]:
            print(f"      空位(y={g['y']}, 间距={g['gap']} vs 常规{g['pitch']})")
            print(f"        前一行: …{g['after_text'][-30:]}")
            print(f"        后一行: {g['before_text'][:30]}…")
        if gaps:
            found_any += 1
        print()

    print("=" * 72)
    print(f"{found_any} 道题找到了空位。")
    print('判据是「行距异常」，所以必须人工核对：标记落在句子中间就是错的。')
    return 0


if __name__ == "__main__":
    sys.exit(main())
