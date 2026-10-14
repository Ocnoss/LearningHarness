"""探查：解析页里的**答案**长什么样、能不能用规则提出来。

═══ 为什么先探查再写抽取 ═══
"从解析里提答案"这一步，做法取决于答案在原文里的形态：
  - 若有显式的 `答案：D` / `【答案】D` 行 → 规则能解决，不该上 LLM（省钱、可复现）；
  - 若答案只隐含在批注里（如"选D"、"D项正确"）→ 规则不可靠，必须上 LLM；
  - 若解析通篇以"正确选项的字母"出现 → 可能可以从选项分析的结构反推。

猜错的代价：写一套正则去捞，失败时看起来像"OCR 不准"，实际是形态判断错了。
所以先把候选模式**数一遍**，用频次说话。

用法: D:\\miniconda\\python.exe scripts\\probe_answer_markers.py --ocr <解析OCR目录>
"""

import argparse
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 候选：答案可能出现的形态
#
# ⚠ 教训：第一版这组模式里**没有** `【参考答案】`，于是数出"零个答案标记"。
# 真实形态是：
#     【参考答案】C 公考最新资料、更新进度微信SKA674
#     【题型与文段类型】中心理解题+科普介绍文章
#     【实战解析】文段分析见批注。……对应C选项，当选；
# 所以"数不出标记"时，第一反应不能是"数据里没有"，而应当是
# **"我的模式表里可能漏了真实形态"**——这两者的处置完全不同。
PATTERNS = [
    ("【参考答案】", re.compile(r"【\s*参\s*考\s*答\s*案\s*】\s*([A-DＡ-Ｄ])")),
    ("【正确答案】", re.compile(r"【\s*正\s*确\s*答\s*案\s*】\s*([A-DＡ-Ｄ])")),
    ("【答案】", re.compile(r"【\s*答\s*案\s*】\s*[:：]?\s*([A-DＡ-Ｄ])")),
    ("题型标记", re.compile(r"【\s*题\s*型[^】]*】")),
    ("实战解析标记", re.compile(r"【\s*实\s*战\s*解\s*析\s*】")),
    ("显式-答案:", re.compile(r"答\s*案\s*[:：]\s*([A-DＡ-Ｄ])")),
    ("正确答案:", re.compile(r"正\s*确\s*答\s*案\s*[:：]\s*([A-DＡ-Ｄ])")),
    ("选X", re.compile(r"选\s*([A-DＡ-Ｄ])\s*(?:项)?")),
    ("X项正确", re.compile(r"([A-DＡ-Ｄ])\s*项\s*正确")),
    ("故X", re.compile(r"故\s*(?:选)?\s*([A-DＡ-Ｄ])\s*(?:项)?")),
    ("对应X选项", re.compile(r"对\s*应\s*([A-DＡ-Ｄ])\s*选\s*项")),
    ("括号选项", re.compile(r"（\s*([A-DＡ-Ｄ])\s*选项\s*）")),
]

# 干扰文本：解析页里有微信/资料推广，混在答案后面。
# 抽取时必须把它切掉，否则会把推广文字写进 analysis。
RE_PROMO = re.compile(r"公考最新资料|更新进度|微信|SKA\d+|QQ群|公众号")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ocr", required=True)
    ap.add_argument("--pages", default="", help="只看这些页，如 1-5。省略=全部")
    args = ap.parse_args()

    texts = []
    for name in sorted(os.listdir(args.ocr)):
        if not name.endswith(".json") or name.startswith("_"):
            continue
        import json

        with open(os.path.join(args.ocr, name), encoding="utf-8") as fh:
            p = json.load(fh)
        texts.append((p.get("page"), p.get("text", "")))

    full = "\n".join(t for _p, t in texts)
    print(f"pages={len(texts)}  chars={len(full)}")
    print("=" * 66)
    print("counts of candidate answer markers:")
    from collections import Counter

    def norm_letter(ch):
        """全角字母归一成半角，否则同一个答案会被数成两种。"""
        return ch.upper().translate(str.maketrans("ＡＢＣＤ", "ABCD"))

    for label, pat in PATTERNS:
        hits = pat.findall(full)
        letters = [norm_letter(h) for h in hits if isinstance(h, str) and len(h) == 1]
        dist = Counter(letters)
        print(f"  {label:<16} total={len(hits):<5} dist={dict(dist.most_common(6)) if letters else '(非字母捕获)'}")

    print()
    print("=" * 66)
    print("promo text found (must be stripped from analysis):")
    promos = RE_PROMO.findall(full)
    print(f"  {len(promos)} hits: {dict(Counter(promos).most_common(6))}")

    print()
    print("=" * 66)
    print("context of 【参考答案】(the real marker):")
    pat = PATTERNS[0][1]
    for m in list(pat.finditer(full))[:5]:
        s = max(0, m.start() - 30)
        e = min(len(full), m.end() + 50)
        print(f"  ...{full[s:e].replace(chr(10), ' / ')}...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
