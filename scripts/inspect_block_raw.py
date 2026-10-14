"""复查：某道题的解析块里到底有没有可用的讲解信息。

═══ 为什么这个复查必要 ═══
端到端验证报出"某题讲解为空、且没有选项评注"。
两种可能的处置完全相反：
  ① 资料本身就没给这道题的讲解（"见批注"是唯一的正文，而批注也没识别出来）
     → 只能如实标注"该题无讲解"，不能编；
  ② 有讲解但我的解析漏了（评注格式不同、或被我的正则切掉了）
     → 修解析。

所以要把它那一整块原文摊开看，而不是看我的解析结果。

用法: D:\\miniconda\\python.exe scripts\\inspect_block_raw.py --ocr <解析目录> --stem "题干前几个字"
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ocr", required=True)
    ap.add_argument("--stem", required=True, help="题干开头若干字，用于定位")
    ap.add_argument("--span", type=int, default=2600, help="打印多少字")
    args = ap.parse_args()

    pages = []
    for name in sorted(os.listdir(args.ocr)):
        if not name.endswith(".json") or name.startswith("_"):
            continue
        with open(os.path.join(args.ocr, name), encoding="utf-8") as fh:
            p = json.load(fh)
        pages.append((p.get("page"), p.get("text", "")))
    pages.sort()
    full = "\n".join(t for _p, t in pages)

    probe = re.sub(r"\s+", "", args.stem)[:14]
    flat = re.sub(r"\s+", "", full)
    pos = flat.find(probe)
    print(f"probe={probe!r}  found_at={pos}")
    if pos < 0:
        print("题干在解析里找不到")
        return 1

    # 映射回原位置（去空白后位置会偏，用比例近似）
    approx = int(pos * (len(full) / max(1, len(flat))))
    lo = max(0, approx - 200)
    hi = min(len(full), approx + args.span)
    block = full[lo:hi]

    print("=" * 74)
    print(f"原文窗口 [{lo}, {hi})，共 {len(block)} 字")
    print("=" * 74)
    print(block)
    print("=" * 74)

    # 在窗口里找所有带括号的短注解 —— 那些可能就是选项评注
    print("窗口内的括号注解：")
    for m in re.finditer(r"[（(]([^）)]{1,20})[）)]", block):
        print(f"  （{m.group(1)}）")
    print()
    print("窗口内是否有答案标记：", bool(re.search(r"参\s*考\s*答\s*案", block)))
    print("窗口内是否有【实战解析】：", bool(re.search(r"实\s*战\s*解\s*析", block)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
