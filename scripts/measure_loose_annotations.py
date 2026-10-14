"""实测：放宽匹配后，逐行正则能把选项评注捞回多少？

═══ 为什么先测量再决定 ═══
坐标重建（`rebuild_reading_order.py`）能改善阅读顺序，但要把版面探测调对
（栏宽、分栏点、合并容差），收益不确定。在此之前先回答一个更便宜的问题：

**不重建顺序，只把匹配放宽，能捞回多少？**

宽松模式：选项字母与它的括号评注**不必在同一行**——
允许在字母之后的 N 个字符内出现 `（…）`。
这样做有风险：可能抓到别的选项的评注，或抓到题型提示（"具体类选项"）。
所以本脚本把**每个选项匹配到的评注与其上下文原文**都打出来，让人看对不对，
而不是只给一个数字。

用法: D:\\miniconda\\python.exe scripts\\measure_loose_annotations.py --report data\\align\\set01-report.json --ocr <解析目录>
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

RE_ANSWER = re.compile(r"【\s*参\s*考\s*答\s*案\s*】\s*([A-DＡ-Ｄ])")
RE_BRACKET = re.compile(r"[（(]([^）)]{1,24})[）)]")

# 明确的负面评注词：只有带这些词的评注才是"这选项错在哪"的说明
NEGATIVE = [
    "有误", "无中生有", "绝对化", "缺主题词", "缺主体", "偷换", "错误", "不当",
    "不准确", "未提及", "偏离", "片面", "过度推断", "强加因果", "不符", "过于绝对",
    "杂糅", "问题表述",
]
# 题型提示：不是"错在哪"，而是"这是什么类别的选项"，不能当负面评注用
HINT_WORDS = ["类选项", "具体类", "区别比较联系类", "原因类", "对策类"]


def classify(note):
    """把一个括号注解分类。"""
    if any(w in note for w in HINT_WORDS):
        return "hint"
    if any(w in note for w in NEGATIVE):
        return "negative"
    return "other"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--ocr", required=True)
    ap.add_argument("--window", type=int, default=120, help="字母之后多少字符内找评注")
    ap.add_argument("--show", type=int, default=3, help="打印几道题的匹配明细")
    args = ap.parse_args()

    with open(args.report, encoding="utf-8") as fh:
        report = json.load(fh)

    pages = []
    for name in sorted(os.listdir(args.ocr)):
        if not name.endswith(".json") or name.startswith("_"):
            continue
        with open(os.path.join(args.ocr, name), encoding="utf-8") as fh:
            p = json.load(fh)
        pages.append((p.get("page"), p.get("text", "")))
    pages.sort()
    full = "\n".join(t for _p, t in pages)

    results = report["results"]
    spans = []
    for i, x in enumerate(results):
        start = x.get("located_at")
        nxt = None
        for j in range(i + 1, len(results)):
            if results[j].get("located_at") is not None:
                nxt = results[j]["located_at"]
                break
        spans.append((start, nxt if nxt is not None else len(full), x))

    stats = {"negative": 0, "hint": 0, "other": 0, "none": 0}
    per_question = []
    shown = 0

    for start, end, x in spans:
        if start is None:
            continue
        block = full[start:end]
        am = RE_ANSWER.search(block)
        region = block[am.start():] if am else block

        found = {}
        for letter in "ABCD":
            # 宽松：先找 "X." 或 "X项" 或 "X选项" 的**最后一次**出现（选项区在答案前后）
            best = None
            for m in re.finditer(rf"(?:^|\n|\s){letter}\s*[.．、]\s*", region):
                seg = region[m.end(): m.end() + args.window]
                bm = RE_BRACKET.search(seg)
                if bm:
                    best = (m.end(), bm.group(1))
            if best:
                found[letter] = {"note": best[1], "kind": classify(best[1])}

        kinds = [v["kind"] for v in found.values()]
        if not found:
            stats["none"] += 1
        elif "negative" in kinds:
            stats["negative"] += 1
        elif "hint" in kinds:
            stats["hint"] += 1
        else:
            stats["other"] += 1

        per_question.append({"no": x["question_no"], "found": found})

        if shown < args.show and found:
            shown += 1
            print(f"\n第{x['question_no']}题  答案={(am.group(1) if am else '?')}")
            for letter, v in sorted(found.items()):
                print(f"   {letter}: [{v['kind']}] {v['note']}")

    print()
    print("=" * 66)
    print(f"逐题结果：有负面评注 {stats['negative']}  只有题型提示 {stats['hint']}  "
          f"其他 {stats['other']}  没捞到 {stats['none']}")
    print()
    print("口径：")
    print("  『有负面评注』= 至少一个选项拿到了『错在哪』的说明 → 这些题的讲解是实打实的")
    print("  『只有题型提示』= 拿到的是『具体类选项』这种分类标注，不是错因 → 不能当讲解用")
    return 0


if __name__ == "__main__":
    sys.exit(main())
