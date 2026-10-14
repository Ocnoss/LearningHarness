"""把题本 OCR 切出来的块按顺序打出来，检查切块本身对不对。

═══ 什么时候需要它 ═══
对齐诊断给出的题干，和报告里同编号的题干**不是同一段文字**——
这种"两个工具对同一份数据得出不同结论"的情况，说明问题在**切块**这一层，
而不是在对齐那一层。所以在改对齐逻辑之前，先把切块结果摊开看。

用法: D:\\miniconda\\python.exe scripts\\dump_blocks.py --ocr <题本OCR目录> [--limit 30]
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from align_by_question import load_pages, parse_question_blocks  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ocr", required=True)
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--role", default="题本", help="按文件名里的角色标记选文件")
    args = ap.parse_args()

    pages = load_pages([args.ocr])
    key = None
    for k in pages:
        if args.role in os.path.basename(k):
            key = k
    if key is None:
        print(f"no file matching role={args.role} in {args.ocr}")
        print(f"  found: {[os.path.basename(k) for k in pages]}")
        return 2

    texts = {p: pl.get("text", "") for p, pl in pages[key].items()}
    print(f"file: {os.path.basename(key)}")
    print(f"pages: {sorted(texts)}")
    print(f"total chars: {sum(len(t) for t in texts.values())}")
    print()

    blocks = parse_question_blocks(texts)
    print(f"parsed {len(blocks)} raw blocks (before dedupe)")
    print("=" * 72)

    # 关键检查：题号序列是否单调递增？重复？跳号？
    nos = [b["no"] for b in blocks]
    print(f"numbers in order: {nos[:60]}")
    dupes = {n: nos.count(n) for n in set(nos) if nos.count(n) > 1}
    print(f"duplicated numbers: {dupes if dupes else 'none'}")
    print()

    seen = set()
    for i, b in enumerate(blocks[: args.limit], 1):
        dup = "  <-- DUPLICATE" if b["no"] in seen else ""
        seen.add(b["no"])
        stem = b["stem"].replace("\n", " ")[:56]
        print(f"[{i:2}] no={b['no']:<4} page={b['page']:<4} opts={len(b['options'])} chars={len(b['text']):<5}{dup}")
        print(f"     {stem}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
