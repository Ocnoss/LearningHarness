"""诊断：为什么某道题的题干在解析里"找不到"？

═══ 为什么要这个诊断，而不是直接把阈值放宽 ═══
对齐时有两题定位失败。两种可能的处置完全不同：
  ① OCR 错字 → 放宽匹配（缩短探针、容忍差异）就能解决；
  ② 解析里确实没有这道题（缺页、题本多印了一题）→ **放宽匹配会把错配伪装成成功**，
     那是最坏的结局：题库里每一题都有答案，只是有些答案是别人的。

所以必须先看清是哪一种。做法：对题干的**每一个长度**做一次查找，
看它是在第几个字符处断掉的——
  - 若在第 12–20 字断掉 → 典型的 OCR 错字（前面都对得上）
  - 若在第 3–5 字就断掉 → 不是错字，是这段文字根本不在解析里
并把断点处两边的文字并排打出来，人能一眼看出是不是错字。

用法: D:\\miniconda\\python.exe scripts\\diagnose_stem_break.py --report data\\align\\set01-report.json --ocr <题本目录> <解析目录>
"""

import argparse
import json
import os
import sys

# 控制台是 GBK，任何含中文/特殊字符的 print 都可能抛 UnicodeEncodeError
# （实测崩在 '\xae' 上）。强制 UTF-8，免得为了一个调试 print 丢掉整轮诊断。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from align_by_question import (  # noqa: E402
    load_pages,
    normalize,
    parse_question_blocks,
)


def probe_breakpoint(stem, full_flat, min_len=4, max_len=40):
    """找题干在哪一个长度处开始"在解析里找不到"。"""
    n = normalize(stem)
    last_ok = 0
    for L in range(min_len, min(max_len, len(n)) + 1):
        if n[:L] in full_flat:
            last_ok = L
        else:
            break
    return last_ok, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--ocr", nargs="*", required=True)
    ap.add_argument("--longest", type=int, default=30)
    args = ap.parse_args()

    with open(args.report, encoding="utf-8") as fh:
        report = json.load(fh)

    failed = [r for r in report["results"] if not r.get("located")]
    if not failed:
        print("no failed items in this report")
        return 0

    pages = load_pages(args.ocr)
    q_key = a_key = None
    for k in pages:
        base = os.path.basename(k)
        if "题本" in base:
            q_key = k
        elif "解析" in base:
            a_key = k

    q_texts = {p: pl.get("text", "") for p, pl in pages[q_key].items()}
    a_texts = {p: pl.get("text", "") for p, pl in pages[a_key].items()}
    a_full_flat = normalize("\n".join(a_texts[p] for p in sorted(a_texts)))

    # ⚠ 键必须是 (套号, 题号)：题号在每套里都从 1 重新开始，
    #   只用题号做键会让第 2、3 套的同号题互相覆盖——
    #   这正是"报告里的 Q4"与"诊断里的 Q4"对不上的原因。
    blocks = {(b.get("set"), b["no"]): b for b in parse_question_blocks(q_texts)}

    print(f"{len(failed)} failed item(s) to diagnose")
    print("=" * 72)
    for item in failed:
        key = (item.get("set"), item["question_no"])
        b = blocks.get(key)
        if b is None:
            print(f"set={key[0]} Q{key[1]}: block not found in 题本")
            continue
        no = item["question_no"]
        last_ok, n = probe_breakpoint(b["stem"], a_full_flat)
        print(f"\nset={key[0]} Q{no}  (题本 p{item['question_page']})")
        print(f"  probe matched up to {last_ok} chars, broke after that")
        print(f"  题干归一化: {n[:args.longest]}")
        if last_ok > 0:
            print(f"  前缀(前{last_ok}字): {n[:last_ok]}")
            print(f"  → 这一串在解析里存在，说明前 {last_ok} 字是对的")
        # 找出解析里最接近的一段：用前缀的最后 6 字去定位，看后面接的是什么
        if last_ok >= 6:
            tail = n[max(0, last_ok - 6):last_ok]
            pos = a_full_flat.find(tail)
            if pos >= 0:
                print(f"  解析里该处之后是: {a_full_flat[pos:pos + args.longest]}")
                print(f"  题本该处之后是:   {n[max(0, last_ok - 6):max(0, last_ok - 6) + args.longest]}")
                print("  → 两边并排看：若是错字，差异会是零星的；若是整句不同，那是另一道题")
        else:
            print("  → 前 6 字就对不上：这段文字**根本不在**解析里（不是 OCR 错字的问题）")

    print("\n" + "=" * 72)
    print("Reading: a break after 12-20 chars = OCR typo -> tolerate.")
    print("         a break before ~6 chars  = different text -> do NOT tolerate.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
