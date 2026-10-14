"""统计：有多少题的讲解/选项评注因"栏式排版"而抓不到。

═══ 问题 ═══
实测这道资料是**双栏 / 页边批注**排版，而 OCR 按行输出。
于是批注行与正文行在文本里交错排列，选项字母与它的评注被拆到相隔很远的行上：

    （对策有误）
    A选项谈论的是"相声创作"的问题、B选项谈论的是"相声表演形式"的问题…
    A选项、B选项问题、对策均不正确，排除；…

逐行正则抓不住这种结构。**但信息是存在的**——需要按 (x, y) 位置重建阅读顺序。

本脚本先量化影响面：有多少题因此拿不到评注、有多少题的讲解是占位。
数字决定下一步是"改渲染/合并逻辑"还是"接受并标注"。

用法: D:\\miniconda\\python.exe scripts\\count_column_damage.py --extracted data\\align\\set01-extracted.json
"""

import argparse
import json
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extracted", required=True)
    args = ap.parse_args()

    with open(args.extracted, encoding="utf-8") as fh:
        data = json.load(fh)

    items = data["items"]
    no_notes = [e for e in items if not (e.get("option_notes") or {})]
    placeholder = [e for e in items if e.get("analysis_is_placeholder")]
    short_analysis = [e for e in items if (e.get("analysis_chars") or 0) < 20]
    no_explanation_mention = [e for e in items if not e.get("explanation_mentions_answer")]

    print(f"总题数: {len(items)}")
    print(f"  没有任何选项评注:        {len(no_notes)}  ({[e['no'] for e in no_notes]})")
    print(f"  讲解是占位（见批注/略）:   {len(placeholder)}")
    print(f"  讲解不足 20 字:          {len(short_analysis)}")
    print(f"  讲解正文未提及答案:       {len(no_explanation_mention)}")
    print()

    print("逐题明细：")
    print("q    ans  评注数  讲解字数  占位  提及答案")
    print("-" * 56)
    for e in items:
        notes = e.get("option_notes") or {}
        print(
            f"{e['no']:<4} {(e.get('answer') or ['-'])[0]:<4} "
            f"{len(notes):<6} {e.get('analysis_chars', 0):<8} "
            f"{str(e.get('analysis_is_placeholder')):<5} "
            f"{e.get('explanation_mentions_answer')}"
        )

    print()
    print("结论口径：")
    print("  - 若『没有任何选项评注』占比高 → 值得改渲染/合并逻辑（按 (x,y) 重建阅读顺序）")
    print("  - 若只是个别题 → 如实标注『该题无讲解』，不编造")
    return 0


if __name__ == "__main__":
    sys.exit(main())
