# -*- coding: utf-8 -*-
"""按坐标重建阅读顺序，并把结果**写回 OCR 页 JSON 的 `text` 字段**。

⚠ 第一行那句编码声明是**必须的**，不是装饰（2026-09-20 实测）：
这台机器上的 `D:\\miniconda\\python.exe` 把 `locale.getpreferredencoding()` 报成 `cp936`，
于是它**用 GBK 解码源文件**——UTF-8 的中文注释在它眼里是坏字节，
脚本直接 `SyntaxError: invalid character '，' (U+FF0C)` 起不来，
而报错位置看着像"第 2 行有问题"，其实是编码判错了。

═══ 为什么需要这一步（2026-09-20 实测）═══
解析篇的排版是"正文 + 页边批注"，而 `ocr_pages.py` 落盘时用的是
**OCR 引擎返回的行序**（它不做任何排序）。于是正文与批注交错，
而下游 `align_by_question.py` 正是**按 `text` 做题干定位**的：

  实测 `align_by_question.py match` → `question blocks=60  located ok=41  failed=19
  verdict=MISALIGNED` —— 三分之一定位不上。

也就是说：**坐标在手边，但没人用它**。本脚本就是那个"用它"的地方。

═══ 为什么写回 `text` 而不是另存 `.txt` ═══
`rebuild_reading_order.py` 原本只写 `.txt`，而下游读的是 JSON 里的 `text`。
两头对不上，所以那个脚本写了两天没人用（工具造好了，但**没接进链**）。
这里把结果写回同一份 JSON 结构（`lines` 原样保留坐标与原始顺序，
只有 `text` 变成按坐标排好的版本），下游一行都不用改。

═══ 它不做什么 ═══
- 不改 `lines`（坐标与 OCR 原始顺序留着，随时能回头核对"排之前是什么样"）；
- 不碰原目录：输出到 `--out` 指定的新目录（**产物目录只增不改**，
  否则"哪些页跑过 OCR"这个断点续跑的依据就被污染了）。

⚠ 调用时必须**给文件名加引号**：`apply-reading-order.py` 里的连字符
会被 Python 当成减号（`apply - reading - order.py`）。
  D:\\miniconda\\python.exe "scripts/apply-reading-order.py" --ocr ... --out ...
"""

import argparse
import json
import os
import sys

# 复用 `rebuild_reading_order.py` 的实现，不抄第二份：
# 抄一份 = 两套判栏参数，迟早不一致（而那时"哪个才对"无法回答）。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    # 注意函数名：`rebuild_reading_order.py` 里的入口叫 `rebuild(payload, tolerance)`，
    # **不是** `rebuild_page`（我第一版按猜的名字导入，直接起不来）。
    from rebuild_reading_order import rebuild  # type: ignore
except Exception as exc:  # noqa: BLE001
    print(f"无法从 rebuild_reading_order 导入 rebuild：{exc}")
    print("（若该函数被改名，请同步这里——排序参数必须只有一份）")
    sys.exit(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ocr", required=True, help="输入 OCR 目录（每页一个 json）")
    ap.add_argument("--out", required=True, help="输出目录（写回 text 字段后的页）")
    ap.add_argument("--report", default="", help="可选：把每页的栏诊断写成一份 JSON")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    files = sorted(f for f in os.listdir(args.ocr) if f.endswith(".json") and not f.startswith("_"))
    if not files:
        print(f"没有页文件：{args.ocr}")
        return 2

    diag = []
    changed = 0
    for name in files:
        with open(os.path.join(args.ocr, name), encoding="utf-8") as fh:
            payload = json.load(fh)

        before = payload.get("text", "")
        lines = payload.get("lines") or []

        # ── 核心：按坐标重排 ──
        # 传**整个页 payload** 而不是拆开的 lines + 页宽：
        # `rebuild()` 自己从 payload 里取 `render_size` 与 `lines`，
        # 页宽的解读只该有一处（我第一版自己算了一遍页宽，等于抄了第二份逻辑）。
        text, info = rebuild(payload)
        payload["text"] = text
        # 出处：这条 text 是怎么来的必须写在产物里——
        # 否则将来看到"两个目录的 text 不一样"会不知道哪个是排过的。
        payload["text_reading_order"] = "coordinate-sorted"
        payload["text_original_length"] = len(before)
        payload["column_info"] = info

        with open(os.path.join(args.out, name), "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)

        if text != before:
            changed += 1
        diag.append(
            {
                "page": payload.get("page"),
                "columns": info.get("columns"),
                "note": info.get("note"),
                "changed": text != before,
                "before_length": len(before),
                "after_length": len(text),
            }
        )

    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(diag, fh, ensure_ascii=False, indent=2)

    cols = {}
    for d in diag:
        cols[d["columns"]] = cols.get(d["columns"], 0) + 1
    print(f"重排 {len(files)} 页 -> {args.out}")
    print(f"  文本发生变化的页：{changed} / {len(files)}")
    print(f"  栏数分布：{cols}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
