"""量一遍：题库里有多少题**应该有视觉空位、但 OCR 之后看不出空位在哪**。

═══ 问题 ═══
作者实测反馈："有些填空题不知道横线或者'空'在哪"。

这是**扫描件 + OCR 的固有问题**：纸质题目的空位通常是一段下划线、一个括号、
或一段留白。OCR 只认"字"，不认"留白"：
  - 下划线可能被识别成一串下划线字符，也可能**完全丢失**；
  - 留白（真正的空）**必然丢失**——那里没有字，也就没有任何输出；
  - 全角括号 `（  ）` 中间的内容丢了，会变成 `（）`，这个反而**能**留下痕迹。

所以"空位丢失"分两类：
  A. **有痕迹**：`____`、`（ ）`、`【 】` —— 能检出、能标注；
  B. **无痕迹**：真正的留白/下划线被完全吃掉 —— 从文本上**无法判断空位在哪**。

本脚本统计 A，并把**可能属于 B** 的题挑出来（题干里出现"填入""填在""画横线处"
这类**题目要求**，但正文里找不到对应的空位标记）。

为什么以"题目要求"为线索：语句填入类题目的题干里几乎必然写着
"填入画横线部分最恰当的一句是"之类的话。**只要出现了这类要求，
而正文里没有任何空位标记，那就是 B 类**——空位丢了。

用法: D:\\miniconda\\python.exe scripts\\audit_blank_markers.py --bank "<题库文件>"
"""

import argparse
import json
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

# A 类痕迹：文本上能看到的空位标记
PRESENT_MARKERS = [
    (r"_{2,}", "下划线"),
    (r"[（(]\s{1,}[）)]", "全角括号内留白"),
    (r"[（(]\s*[）)]", "空括号"),
    (r"[【\[]\s*[】\]]", "空方括号"),
    (r"横线", "提到横线"),
    (r"填入|填在|填写", "填空要求"),
]

# "题目要求里提到要填/填入"——出现它，正文就该有空位
REQUIRES_BLANK = re.compile(r"(填入|填在|画横线|填入画|最适合填入|依次填入|填到)")

# 只是普通含"空"字的词，**不算**空位标记。
# 我第一版用 /空/ 去匹配，把"空前的压力""太空发射系统"都当成了空位标记——
# 那是误报，会把"本来正常的题"标成有问题，比不标更糟。
FALSE_POSITIVE_WORDS = ["空前", "太空", "空气", "时空", "天空", "空白处", "空间", "空缺", "高空", "真空"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bank", required=True)
    ap.add_argument("--examples", type=int, default=6)
    args = ap.parse_args()

    with open(args.bank, encoding="utf-8") as fh:
        bank = json.load(fh)

    total = len(bank.get("questions", []))
    print(f"题库：{bank.get('title')}  共 {total} 道")

    kinds = {}
    for q in bank["questions"]:
        kinds[q.get("kind")] = kinds.get(q.get("kind"), 0) + 1
    print(f"题型分布：{kinds}")
    print()

    with_marker = []
    requires_but_no_marker = []
    requires_any = []

    for q in bank["questions"]:
        stem = q.get("stem") or ""
        opts = " ".join(q.get("options") or [])
        whole = stem + " " + opts

        found = []
        for pat, label in PRESENT_MARKERS:
            if re.search(pat, whole):
                found.append(label)

        requires = bool(REQUIRES_BLANK.search(stem))
        if requires:
            requires_any.append((q, found))
        if found:
            with_marker.append((q, found))
        elif requires:
            requires_but_no_marker.append(q)

    print("=" * 72)
    print(f"A 类（文本上有空位痕迹）：{len(with_marker)} 道")
    for q, found in with_marker[: args.examples]:
        print(f"  {q['source']['number']}  [{q['kind']}] 痕迹={found}")
        print(f"      {q['stem'].replace(chr(10), ' ')[:60]}")
    print()
    print("=" * 72)
    print(f"题目要求里提到'填入'的题：{len(requires_any)} 道")
    for q, found in requires_any[: args.examples]:
        mark = found if found else "**没有任何空位标记 → 空位很可能丢了**"
        print(f"  {q['source']['number']}  {mark}")
        print(f"      {q['stem'].replace(chr(10), ' ')[:70]}")
    print()
    print("=" * 72)
    print(f"★ B 类（要求填入但正文无空位标记）：{len(requires_but_no_marker)} 道")
    for q in requires_but_no_marker:
        print(f"  {q['source']['number']}")
        print(f"      {q['stem'].replace(chr(10), ' ')[:80]}")
    print()
    print("判定口径：")
    print("  A 类能标注（把痕迹高亮给人看）；B 类从文本上无法判断空位在哪。")
    print("  对 B 类的正确处置不是猜，而是**标注该题空位不可靠**，")
    print("  或者在来源资料上重新取一次（放大/更高中文识别精度）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
