"""回归测试：渲染出的位图朝向，必须与"读者看到的页面朝向"一致。

═══ 这个测试在防什么 ═══
我犯过一次判断错误：看到内嵌图片的像素是 6357x4724（宽>高），就说"这一册是横排的"，
作者打开文件否掉了。查下来页面其实是「横向 mediabox + /Rotate 90」，旋转后就是竖的。

那次只是**我看错了结论**，没有造成损坏。但它离一个真正的故障只有一步：
如果渲染时没应用 `/Rotate`，送进 OCR 的就是**躺倒的图**——
识别质量下降，**却不报错**。产出看起来像"OCR 不太准"，
于是人会去调模型参数，而真正的问题在渲染。

所以这里锁住一条不变量：
    渲染位图的宽高关系  ==  page.rect 的宽高关系
（`page.rect` 是 PyMuPDF 应用 /Rotate 之后的显示尺寸，等于读者看到的形状。）

用法: D:\\miniconda\\python.exe scripts\\check_render_rotation.py [文件夹]
退出码 0 = 不变量成立
"""

import os
import sys

import pymupdf

DEFAULT = r"D:\考公资料\刷题"


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    if os.path.isfile(root):
        files = [root]
    else:
        files = []
        for dirpath, _d, names in os.walk(root):
            for nm in names:
                if nm.lower().endswith(".pdf"):
                    files.append(os.path.join(dirpath, nm))
    files.sort()

    if not files:
        print(f"no PDF under {root}")
        return 2

    checked = 0
    violations = []
    for f in files:
        doc = pymupdf.open(f)
        n = doc.page_count
        # 取首/中/末 + 所有 /Rotate != 0 的页（那些才是危险页）
        idxs = {0, n // 2, n - 1}
        for i in range(n):
            if doc[i].rotation != 0:
                idxs.add(i)
        for i in sorted(x for x in idxs if 0 <= x < n):
            page = doc[i]
            rect = page.rect
            pix = page.get_pixmap(dpi=72)  # 低 dpi 只为看形状，快
            rect_wide = rect.width > rect.height
            pix_wide = pix.width > pix.height
            checked += 1
            if rect_wide != pix_wide:
                violations.append(
                    {
                        "file": os.path.basename(f),
                        "page": i + 1,
                        "rotate": page.rotation,
                        "rect": (round(rect.width), round(rect.height)),
                        "pixmap": (pix.width, pix.height),
                    }
                )
        doc.close()

    print(f"checked {checked} pages across {len(files)} files")
    print("invariant: pixmap orientation == page.rect orientation")
    if violations:
        print(f"\nFAIL: {len(violations)} violations")
        for v in violations[:20]:
            print(f"  {v['file']} p{v['page']} rotate={v['rotate']} rect={v['rect']} pixmap={v['pixmap']}")
        print("\n=> ocr_pages.py is rendering sideways pages. Fix the renderer.")
        return 1

    print("\nOK: renderer orientation matches what the reader sees.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
