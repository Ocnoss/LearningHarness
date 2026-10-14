"""对指定 PDF 的若干页做 OCR，结果按页落成 UTF-8 JSON（可断点续跑）。

═══ 为什么单独一个脚本，而不是塞进插件 ═══
ADR-015：建模与运行分离。OCR 是**建**的阶段（一次性、离线、慢），
插件是**跑**的阶段（每次会话都要快）。把 OCR 塞进插件会让每次刷题都背上几分钟的解析。
所以：本脚本产出**中间产物**（每页文字），提取插件只读这些产物。

═══ 两个必须做对的地方 ═══
1. **断点续跑**：全量 2332 页、单页 1.5s，中途断掉要从头来是不可接受的。
   所以每页单独落一个文件，已存在就跳过（除非给 --force）。
   单页一个文件而不是一个大 JSON，是因为"写一个 2332 页的大 JSON"在中断时会留下半截文件，
   而按页写则天然可续。
2. **降采样**：实测有 6357×4724 的页面，直接送 OCR 单页要好几秒。
   按"长边不超过 --max-side"缩放，既快又几乎不影响识别（模型输入本来就会缩放）。

用法:
  D:\\miniconda\\python.exe scripts\\ocr_pages.py --pdf "<路径>" --pages 1-10 --out data\\ocr\\<名字>
  D:\\miniconda\\python.exe scripts\\ocr_pages.py --pair data\\pairing.json --sample 20
"""

import argparse
import io
import json
import os
import sys
import time

import numpy as np
import pymupdf
from PIL import Image


def parse_pages(spec, page_count):
    """把 "1-10,15,20-25" 解析成 0 基页码列表。"""
    if not spec:
        return list(range(page_count))
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
            for p in range(start, end + 1):
                if 1 <= p <= page_count:
                    out.append(p - 1)
        else:
            p = int(part)
            if 1 <= p <= page_count:
                out.append(p - 1)
    # 去重且保序
    seen = set()
    uniq = []
    for p in out:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq


def spread_pages(page_count, n):
    """在整本书里均匀取 n 页（跳过封面页）。

    为什么要"均匀"而不是"前 n 页"：我们要校验的是**配对关系**，
    而配对是贯穿全书的（上/下分册、题号范围）。只看前几页无法发现
    "题本【上】其实对应解析【下】"这类错误。
    """
    if n >= page_count:
        return list(range(page_count))
    start = 1 if page_count > 3 else 0  # 跳过封面
    step = (page_count - start) / n
    return sorted({min(page_count - 1, int(start + i * step)) for i in range(n)})


def render(doc, page_index, max_side):
    """渲染一页成 PIL 图，必要时降采样。"""
    page = doc[page_index]
    # 先按 150 dpi 渲染（A4 约 1240x1754），再按 max_side 限制长边
    pix = page.get_pixmap(dpi=150)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    w, h = img.size
    longest = max(w, h)
    if longest > max_side:
        scale = max_side / longest
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", help="要 OCR 的 PDF 路径")
    ap.add_argument("--pages", default="", help='页码，如 "1-10,15"。省略=全部')
    ap.add_argument("--out", help="输出目录（每页一个 json）")
    ap.add_argument("--max-side", type=int, default=2000, help="渲染长边上限，默认 2000")
    ap.add_argument("--force", action="store_true", help="重跑已完成的页")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not args.pdf or not args.out:
        print("--pdf 与 --out 必填")
        return 2

    os.makedirs(args.out, exist_ok=True)
    doc = pymupdf.open(args.pdf)
    targets = parse_pages(args.pages, doc.page_count)

    todo = []
    for p in targets:
        dst = os.path.join(args.out, f"page-{p + 1:04d}.json")
        if os.path.exists(dst) and not args.force:
            continue
        todo.append((p, dst))

    meta_path = os.path.join(args.out, "_meta.json")
    existing = {}
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as fh:
            existing = json.load(fh)
    existing.update({"pdf": os.path.abspath(args.pdf), "page_count": doc.page_count, "max_side": args.max_side})
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(existing, fh, ensure_ascii=False, indent=2)

    if not todo:
        print(f"nothing to do: {len(targets)} pages already cached in {args.out}")
        return 0

    # 引擎只加载一次（0.4s），逐页复用
    from rapidocr import RapidOCR  # noqa: PLC0415

    engine = RapidOCR()

    print(f"OCR {len(todo)} pages -> {args.out}")
    t_all = time.time()
    for i, (p, dst) in enumerate(todo, 1):
        t0 = time.time()
        img = render(doc, p, args.max_side)
        result = engine(np.array(img))
        dt = time.time() - t0

        # rapidocr 的返回：有 txts/scores/boxes，也可能整页无文字
        txts = list(getattr(result, "txts", None) or [])
        scores = list(getattr(result, "scores", None) or [])
        boxes = getattr(result, "boxes", None)
        lines = []
        for j, txt in enumerate(txts):
            box = None
            if boxes is not None and j < len(boxes):
                try:
                    box = [[float(x), float(y)] for x, y in boxes[j]]
                except Exception:  # noqa: BLE001
                    box = None
            lines.append({"text": txt, "score": float(scores[j]) if j < len(scores) else None, "box": box})

        payload = {
            "page": p + 1,
            "pdf": os.path.abspath(args.pdf),
            "render_size": list(img.size),
            "seconds": round(dt, 2),
            "line_count": len(lines),
            "text": "\n".join(x["text"] for x in lines),
            "lines": lines,
        }
        tmp = dst + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, dst)  # 原子落盘，中断不会留半截文件

        if not args.quiet:
            print(f"  [{i}/{len(todo)}] page {p + 1}: {len(lines)} lines, {dt:.1f}s")

    doc.close()
    total = time.time() - t_all
    print(f"done: {len(todo)} pages in {total:.0f}s ({total / max(1, len(todo)):.1f}s/page)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
