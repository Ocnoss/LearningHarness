"""量一遍刷题资料的规模：页数、每页图片分辨率、是否真无文本层。

为什么要单独写这个脚本而不是随手一行：
规模数字决定 OCR 路线的可行性（几十分钟 vs 几小时），也决定要不要做断点续跑。
用一次性的命令行拼字符串很容易把结论弄错，而这里错一次就会误导后面的所有决定。

两个踩出来的坑，都写在这里免得再犯：
1. **不要用 `*.pdf` + `*.PDF` 两个 glob 去凑** —— Windows 文件系统大小写不敏感，
   两个模式匹配同一批文件，于是每个文件被统计两次（实测把 2332 页报成了 4664 页）。
   正确做法是搜 `*` 再按后缀小写过滤，并用 realpath 去重。
2. **不要指望控制台能显示中文**（实测 GBK 控制台把路径显示成乱码）。
   结论写进 JSON 文件再读回，stdout 只打印 ASCII 摘要。

用法: D:\\miniconda\\python.exe scripts\\pdf-survey.py [根目录]
输出: data/pdf-survey.json
"""

import os
import sys
import json

import pymupdf

DEFAULT_ROOT = r"D:\考公资料\刷题"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "pdf-survey.json")


def find_pdfs(root):
    """找出所有 PDF，按 realpath 去重。

    大小写不敏感的文件系统上，`*.pdf` 与 `*.PDF` 是同一批文件——
    两个 glob 相加会让每个文件出现两次。这里用一次遍历 + 小写后缀判断。
    """
    seen = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if not name.lower().endswith(".pdf"):
                continue
            full = os.path.join(dirpath, name)
            key = os.path.normcase(os.path.realpath(full))
            seen.setdefault(key, full)
    return sorted(seen.values())


def survey(path, sample_pages=6):
    """探查一个 PDF。"""
    doc = pymupdf.open(path)
    n = doc.page_count

    # 文本层：全查太慢，抽样看前中后
    idxs = sorted({0, n // 4, n // 2, (3 * n) // 4, n - 1} | set(range(min(sample_pages, n))))
    text_chars = 0
    rotations = {}
    effective = {}
    raw_shapes = {}
    for i in idxs:
        if not (0 <= i < n):
            continue
        page = doc[i]
        text_chars += len(page.get_text().strip())
        rotations[page.rotation] = rotations.get(page.rotation, 0) + 1
        # ⚠ 判"横竖"必须用 page.rect（= 应用 /Rotate 之后的显示尺寸），
        #   而不是内嵌图片的像素形状，也不是 mediabox。
        r = page.rect
        effective[(round(r.width), round(r.height))] = effective.get((round(r.width), round(r.height)), 0) + 1
        # 内嵌图原始像素形状：这个值**不代表读者看到的朝向**，
        # 记下来只是为了说明"扫描仪可能横着存 + 用 /Rotate 转回来"
        for img in page.get_images(full=True)[:1]:
            try:
                base = doc.extract_image(img[0])
                k = "wide" if base["width"] > base["height"] else "tall"
                raw_shapes[k] = raw_shapes.get(k, 0) + 1
            except Exception:  # noqa: BLE001
                pass

    # 结论用**占比最大的显示尺寸**
    orient = "?"
    if effective:
        w, h = max(effective.items(), key=lambda kv: kv[1])[0]
        orient = "portrait" if h >= w else "landscape"

    first = doc[0]
    info = []
    for img in first.get_images(full=True):
        try:
            base = doc.extract_image(img[0])
            info.append((base.get("width", 0), base.get("height", 0), base.get("ext", "?")))
        except Exception as err:  # noqa: BLE001
            info.append((0, 0, f"err:{err}"))

    doc.close()
    return {
        "path": path,
        "pages": n,
        "sampled": len(idxs),
        "text_chars": text_chars,
        "orientation": orient,
        "page_rects": effective,
        "rotations": rotations,
        "raw_image_shapes": raw_shapes,
        "images": info[:3],
    }


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ROOT
    files = find_pdfs(root)

    if not files:
        print(f"no PDF found under: {root}")
        return 1

    print(f"found {len(files)} PDF files (deduped) under: {root}")
    print()

    results = []
    for f in files:
        try:
            r = survey(f)
        except Exception as err:  # noqa: BLE001
            print(f"  UNREADABLE: {os.path.basename(f)}: {err}")
            continue
        r["size_mb"] = round(os.path.getsize(f) / 1024 / 1024, 1)
        r["rel"] = os.path.relpath(f, root)
        results.append(r)

        # stdout 只打 ASCII，中文进 JSON
        print(
            f"  pages={r['pages']:<5} size={r['size_mb']:7.1f}MB  orient={r['orientation']:<9} "
            f"rot={r['rotations']}  text={r['text_chars']:<5} "
            f"{'TEXT' if r['text_chars'] >= 20 else 'SCAN'}"
        )

    total_pages = sum(r["pages"] for r in results)
    print()
    print("=" * 60)
    print(f"TOTAL PAGES: {total_pages}  ({len(results)} files)")
    for sec in (1, 2, 4):
        mins = total_pages * sec / 60
        print(f"  at {sec}s/page -> ~{mins:.0f} min ({mins/60:.1f} h)")
    print()
    print("NOTE: this is the WHOLE material set. The first scenario is only")
    print("      '片段阅读600题' -- do that folder first, not everything.")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(
            {"root": root, "total_pages": total_pages, "files": results},
            fh,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\nJSON written: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
