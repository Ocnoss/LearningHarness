"""查证"页面到底是不是横排"——区分三件不同的事。

═══ 这个脚本为什么存在 ═══
我犯过一个错：看到抽取出的原始图片是 6357x4724（宽>高），就断言"这一册是横排的"。
作者打开文件看了，说和其他文件没区别。他是对的。

错在哪：**"内嵌图片的像素尺寸"不等于"读者看到的页面朝向"。**
两者之间还夹着一个 `/Rotate` 参数（0/90/180/270），查看器会按它旋转后再显示。
扫描仪把 A4 横着存、标 /Rotate 90 是常见做法。

所以判"横竖"必须看三个量，而不是一个：
  1. `MediaBox`（页面尺寸，PDF 用户空间）
  2. `/Rotate`（查看器要额外旋转的角度）
  3. **旋转后的有效宽高** ← 这个才等于读者看到的样子

用法: D:\\miniconda\\python.exe scripts\\page_orientation.py "<文件夹>"
"""

import os
import sys

import pymupdf


def describe(path, sample=40):
    doc = pymupdf.open(path)
    n = doc.page_count
    idxs = sorted({0, n // 4, n // 2, (3 * n) // 4, n - 1})
    idxs = [i for i in idxs if 0 <= i < n]

    rotates = {}
    eff_sizes = {}
    raw_shapes = {}
    for i in idxs:
        page = doc[i]
        rot = page.rotation  # 查看器额外旋转角度
        rotates[rot] = rotates.get(rot, 0) + 1
        mb = page.mediabox
        w, h = mb.width, mb.height
        # 应用旋转后的有效尺寸
        if rot in (90, 270):
            w, h = h, w
        eff_sizes[(round(w), round(h))] = eff_sizes.get((round(w), round(h)), 0) + 1
        # 内嵌图的原始像素形状（我上次错误地只看了这个）
        for img in page.get_images(full=True)[:1]:
            try:
                base = doc.extract_image(img[0])
                shape = "landscape" if base["width"] > base["height"] else "portrait"
                raw_shapes[shape] = raw_shapes.get(shape, 0) + 1
            except Exception:  # noqa: BLE001
                pass

    doc.close()
    return {
        "pages": n,
        "sampled": idxs,
        "rotations": rotates,
        "effective_sizes": eff_sizes,   # 读者看到的
        "raw_image_shapes": raw_shapes,  # 我上次误读的那个
    }


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else r"D:\考公资料\刷题"
    files = []
    for dirpath, _d, names in os.walk(root):
        for nm in names:
            if nm.lower().endswith(".pdf"):
                files.append(os.path.join(dirpath, nm))
    files.sort()

    print(f"{len(files)} PDF under {os.path.basename(root)}\n")
    for f in files:
        r = describe(f)
        print(os.path.basename(f))
        print(f"   pages={r['pages']}  /Rotate分布={r['rotations']}")
        print(f"   旋转后的有效页面尺寸(点)={r['effective_sizes']}")
        print(f"   内嵌图原始像素形状={r['raw_image_shapes']}   <- 上次我只看这个，所以判错了")
        # 结论：有效尺寸里哪个维度更大
        eff = list(r["effective_sizes"].keys())
        if eff:
            w, h = eff[0]
            verdict = "PORTRAIT (tall)" if h > w else "LANDSCAPE (wide)"
            print(f"   结论：{verdict}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
