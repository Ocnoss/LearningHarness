"""打印提取结果的指定题，并**在原解析全文里搜索**该题应有的答案标记。

═══ 为什么要有"搜索"这部分 ═══
提取失败的题有两种可能，处置完全不同：
  ① 答案标记在本题的 OCR 文字里**根本没被识别出来** → 需要放宽阈值或重跑该页 OCR；
  ② 标记被识别了，但**落在了本题范围之外**（相邻题的范围划分错了）→ 需要查对齐范围。
只说"没找到"无法区分这两者，所以这里直接在原文里全文搜索，并把命中位置打出来。

用法:
  D:\\miniconda\\python.exe scripts\\show_extracted.py --extracted data\\align\\set01-extracted.json --index 1
  D:\\miniconda\\python.exe scripts\\show_extracted.py --extracted ... --search-missing --ocr <解析目录>
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

RE_ANSWER_LOOSE = re.compile(r"参\s*考\s*答\s*案|参考答案|【.*答.*案.*】")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extracted", required=True)
    ap.add_argument("--index", type=int, default=0, help="从 1 起；省略则打印摘要")
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--ocr", help="解析 OCR 目录（用于搜索缺失的标记）")
    ap.add_argument("--search-missing", action="store_true")
    args = ap.parse_args()

    with open(args.extracted, encoding="utf-8") as fh:
        data = json.load(fh)

    items = data["items"]

    if args.search_missing and args.ocr:
        texts = []
        for name in sorted(os.listdir(args.ocr)):
            if not name.endswith(".json") or name.startswith("_"):
                continue
            with open(os.path.join(args.ocr, name), encoding="utf-8") as fh:
                p = json.load(fh)
            texts.append((p.get("page"), p.get("text", "")))
        texts.sort()
        full = "\n".join(t for _p, t in texts)

        missing = [e for e in items if not e.get("answer")]
        print(f"{len(missing)} item(s) without answer; searching raw text")
        print("=" * 74)
        for e in missing:
            print(f"\nset={e['set']} q={e['no']}  (题本 p{e['question_page']})")
            print(f"  stem: {(e.get('stem') or '')[:60]}")
            for o in e.get("options") or []:
                print(f"    {o['label']}. {o['text'][:40]}")
            # 在全文里找这道题的题干，看它周围有没有答案标记
            head = re.sub(r"\s+", "", (e.get("stem") or ""))[:16]
            pos = re.sub(r"\s+", "", full).find(head)
            print(f"  题干在解析全文里的位置: {pos}")
            if pos >= 0:
                # 把位置映射回原始文本（归一化去掉了空白，位置会偏；用近似窗口）
                lo = max(0, int(pos * 0.95) - 200)
                hi = min(len(full), int(pos * 1.15) + 800)
                window = full[lo:hi]
                hits = list(RE_ANSWER_LOOSE.finditer(window))
                print(f"  该窗口内疑似答案标记: {len(hits)} 处")
                for m in hits[:5]:
                    s = max(0, m.start() - 60)
                    print(f"     ...{window[s:m.end() + 60]}...".replace("\n", " / "))
            else:
                print("  题干在解析全文里也找不到（题干文字本身可能 OCR 有误）")
        return 0

    if args.index <= 0:
        print(f"total={data['total']}  confidence={data['confidence_dist']}")
        print(f"suspicious={data['suspicious_count']}")
        print("")
        for i, e in enumerate(items, 1):
            ans = ",".join(e.get("answer") or []) or "-"
            print(f"  #{i:2} set={e['set']} q={e['no']:<3} ans={ans:<3} conf={e.get('confidence'):<7} "
                  f"type={(e.get('question_type') or '-')[:18]:<20} analysis={e.get('analysis_chars', 0)}字")
        return 0

    for e in items[args.index - 1: args.index - 1 + args.count]:
        print("=" * 74)
        print(f"第{e['set']}套 第{e['no']}题   答案={e.get('answer')}   置信度={e.get('confidence')}")
        print("=" * 74)
        print("【题干】")
        print((e.get("stem") or "").strip())
        print("【选项】")
        for o in e.get("options") or []:
            print(f"   {o['label']}. {o['text']}")
        print(f"【题型】{e.get('question_type')}")
        print("【各选项评注】", json.dumps(e.get("option_annotations") or {}, ensure_ascii=False))
        print(f"【讲解提及答案】{e.get('explanation_mentions_answer')} {e.get('mention_text') or ''}")
        print(f"【讲解】{e.get('analysis_chars', 0)} 字")
        print((e.get("analysis") or "").strip()[:900])
        if e.get("reason"):
            print(f"\n⚠ {e['reason']}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
