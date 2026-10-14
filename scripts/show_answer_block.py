"""把某道题的解析块**全文**打印出来，看清答案藏在哪。

═══ 为什么需要看全文 ═══
`probe_answer_markers.py` 数出解析里**一个显式答案标记都没有**
（`答案：`、`正确答案`、`选X`、`故X`、`X项正确` 全部 0 命中）。
这意味着答案必须从讲解文字里**推**出来。

但要推得先看清"推的依据长什么样"。看前 120 字不够——答案常常在讲解的末尾
（"因此……应选……"）或藏在批注里。所以这个脚本把整块完整打出来，不做截断。

用法: D:\\miniconda\\python.exe scripts\\show_answer_block.py --report data\\align\\set01-report.json --index 1 --ocr <解析目录>
"""

import argparse
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--ocr", required=True)
    ap.add_argument("--index", type=int, default=1, help="报告里的第几题（从 1 起）")
    ap.add_argument("--count", type=int, default=1)
    args = ap.parse_args()

    with open(args.report, encoding="utf-8") as fh:
        report = json.load(fh)

    # 解析全文（按页序拼）
    texts = []
    for name in sorted(os.listdir(args.ocr)):
        if not name.endswith(".json") or name.startswith("_"):
            continue
        with open(os.path.join(args.ocr, name), encoding="utf-8") as fh:
            p = json.load(fh)
        texts.append((p.get("page"), p.get("text", "")))
    texts.sort()
    full = "\n".join(t for _p, t in texts)

    items = report["results"][args.index - 1: args.index - 1 + args.count]
    for x in items:
        start = x.get("located_at")
        end = x.get("answer_text_full")
        print("=" * 74)
        print(f"第{x['set']}套 第{x['question_no']}题   解析起点={start}")
        print("=" * 74)
        print("【题本给我们的】")
        print((x.get("stem_full") or x.get("stem_head") or "").strip())
        for o in x.get("options") or []:
            print(f"   {o['label']}. {o['text']}")
        print()
        if start is None:
            print("(未定位到解析)")
            continue
        # 用下一题的起点作为终点；报告里已存了 answer_text_full，直接用它
        body = x.get("answer_text_full") or ""
        print(f"【解析全文】（{len(body)} 字）")
        print(body)
        print()


if __name__ == "__main__":
    sys.exit(main())
