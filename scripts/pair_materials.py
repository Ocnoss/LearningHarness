"""刷题资料的配对分析：谁和谁是一对、范围如何、置信度多少。

═══ 为什么这件事必须有脚本，而不是靠 agent 临场判断 ═══
作者的要求是"agent 读文件名确定配对，再抽几题简单校验一下是不是对应的"。
这里的风险不是"读不懂文件名"，而是**配对错了却看不出来**——
一旦错配，OCR 与 LLM 分块会烧掉几十分钟，产出的是一个答案全错位的题库，
而题库本身看起来完全正常（每题都有答案，只是答案是别人的）。

所以配对要产出**带证据的结论**：
  - 文件名证据（题本/解析、篇/本、上/下）
  - 目录证据（练习题的编号区间，来自各文件首页 OCR）
  - 题号证据（文件两端出现的题号，来自正文 OCR）
并且把"是否有把握"明确写出来，交给作者确认（作者已定：先看方案再跑）。

用法: D:\\miniconda\\python.exe scripts\\pair_materials.py --dir "D:\\考公资料\\刷题\\片段阅读600题" --ocr data\\ocr\\_smoke*
输出: data/pairing.json
"""

import argparse
import json
import os
import re
import sys

OUT_DEFAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "pairing.json")

# ── 文件名后缀分类 ──
# 顺序有意义：先匹配更具体的（"解析"里有"解"，"题本"里有"题"）
KEY_QUESTION = [("题本", "题本"), ("题本篇", "题本"), ("试题", "题本"), ("题目", "题本"), ("练习", "题本")]
KEY_ANSWER = [("解析", "解析"), ("答案解析", "解析"), ("答案", "解析"), ("题解", "解析"), ("详解", "解析")]

# ── 分册标记 ──
VOLUME_PATTERNS = [
    (r"[【\[（(]\s*上\s*[】\]）)]", "上"),
    (r"[【\[（(]\s*下\s*[】\]）)]", "下"),
    (r"[【\[（(]\s*中\s*[】\]）)]", "中"),
    (r"上册", "上"),
    (r"下册", "下"),
    (r"中册", "中"),
    (r"[-_ ]part\s*([123])", None),  # 预留
]

# ── 其他资料类型（作者定义的五类之一） ──
KEY_NOTE = [("笔记", "笔记"), ("手写", "笔记"), ("错题", "笔记")]
KEY_LECTURE = [("讲义", "讲义"), ("教程", "讲义"), ("课程", "讲义")]
KEY_ANSWER_SHEET_SEP = [("答案", "解析")]


def classify(filename):
    """从文件名判断：资料类型 + 分册。

    只做机械判断，**不猜**。判不出类型就返回 None，让上层报"需要人工指定"，
    而不是默认归到某一类——默认归类会让错误藏起来。
    """
    stem = os.path.splitext(filename)[0]
    kind = None
    key = None

    # 先看是不是"解析"（因为"答案解析"里也可能含"题"）
    for k, v in KEY_ANSWER:
        if k in stem:
            kind, key = v, k
            break
    if kind is None:
        for k, v in KEY_QUESTION:
            if k in stem:
                kind, key = v, k
                break
    if kind is None:
        for k, v in KEY_NOTE:
            if k in stem:
                kind, key = v, k
                break
    if kind is None:
        for k, v in KEY_LECTURE:
            if k in stem:
                kind, key = v, k
                break

    volume = None
    for pat, label in VOLUME_PATTERNS:
        m = re.search(pat, stem)
        if m:
            volume = label if label else m.group(1)
            break

    # 去掉"题本/解析/上/下"等标记，剩下的就是"这套资料的名字"——
    # 名字相同才可能是配对，这是配对的第一道门槛。
    base = stem
    for k, _ in KEY_ANSWER + KEY_QUESTION + KEY_NOTE + KEY_LECTURE:
        base = base.replace(k, "")
    for pat, _ in VOLUME_PATTERNS:
        base = re.sub(pat, "", base)
    base = re.sub(r"[【】\[\]（）()\s\-_]+", "", base)

    return {"kind": kind, "key": key, "volume": volume, "base": base}


def parse_toc(text):
    """从目录页文本里抽 (套号, 页码)。

    实测目录形如：
        练习题 01 套
        001
        练习题02套
        007
    OCR 会在数字与汉字间插空格，所以要容忍空白。
    """
    entries = []
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    for i, ln in enumerate(lines):
        m = re.search(r"练习题\s*(\d{1,3})\s*套?", ln)
        if not m:
            continue
        num = int(m.group(1))
        # 页码通常在下一行的纯数字
        page = None
        for j in range(i + 1, min(i + 3, len(lines))):
            if re.fullmatch(r"\d{1,4}", lines[j]):
                page = int(lines[j])
                break
        entries.append({"set": num, "page": page})
    return entries


def find_question_numbers(text):
    """从正文里找题号（行首的 "N." 或 "N、"）。"""
    nums = []
    for ln in text.split("\n"):
        m = re.match(r"\s*(\d{1,3})\s*[.．、]", ln)
        if m:
            n = int(m.group(1))
            if 1 <= n <= 999:
                nums.append(n)
    return nums


def load_ocr_pages(ocr_dirs):
    """把多个 ocr 输出目录读成 {pdf路径: {页码: 文本}}。"""
    by_pdf = {}
    for d in ocr_dirs:
        if not os.path.isdir(d):
            continue
        meta = {}
        mp = os.path.join(d, "_meta.json")
        if os.path.exists(mp):
            with open(mp, encoding="utf-8") as fh:
                meta = json.load(fh)
        pdf = meta.get("pdf")
        for name in sorted(os.listdir(d)):
            if not name.endswith(".json") or name.startswith("_"):
                continue
            with open(os.path.join(d, name), encoding="utf-8") as fh:
                payload = json.load(fh)
            p = payload.get("page")
            pdf_path = payload.get("pdf") or pdf
            if not pdf_path or not p:
                continue
            by_pdf.setdefault(os.path.normcase(os.path.abspath(pdf_path)), {})[p] = payload.get("text", "")
    return by_pdf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="资料文件夹")
    ap.add_argument("--ocr", nargs="*", default=[], help="已 OCR 的输出目录（用于取证）")
    ap.add_argument("--out", default=OUT_DEFAULT)
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        print(f"目录不存在: {args.dir}")
        return 2

    files = []
    for name in sorted(os.listdir(args.dir)):
        full = os.path.join(args.dir, name)
        if os.path.isfile(full) and name.lower().endswith(".pdf"):
            info = classify(name)
            info["file"] = name
            info["path"] = full
            info["size_mb"] = round(os.path.getsize(full) / 1024 / 1024, 1)
            files.append(info)

    pages_by_pdf = load_ocr_pages(args.ocr)

    # 补充 OCR 证据
    for f in files:
        key = os.path.normcase(os.path.abspath(f["path"]))
        pages = pages_by_pdf.get(key, {})
        f["ocr_pages"] = sorted(pages.keys())

        # 目录：第一页（实测目录在第 1 页）；若为空则试第 2 页
        toc = []
        for cand in (1, 2):
            if cand in pages and pages[cand].strip():
                toc = parse_toc(pages[cand])
                if toc:
                    break
        f["toc"] = toc
        if toc:
            sets = [e["set"] for e in toc if e["set"] is not None]
            f["set_range"] = [min(sets), max(sets)] if sets else None
        else:
            f["set_range"] = None

        # 题号：所有已 OCR 页里出现的题号
        all_nums = []
        for p in sorted(pages.keys()):
            all_nums.extend(find_question_numbers(pages[p]))
        f["question_numbers_seen"] = sorted(set(all_nums))
        f["question_no_min"] = min(all_nums) if all_nums else None
        f["question_no_max"] = max(all_nums) if all_nums else None

    # ── 配对 ──
    questions = [f for f in files if f["kind"] == "题本"]
    answers = [f for f in files if f["kind"] == "解析"]
    others = [f for f in files if f["kind"] not in ("题本", "解析")]

    pairs = []
    used = set()
    for q in questions:
        # 候选：同 base 优先，其次任意解析文件
        cands = [a for a in answers if a["file"] not in used]
        same_base = [a for a in cands if a["base"] == q["base"]]
        pool = same_base or cands

        # 分册匹配优先
        same_vol = [a for a in pool if a["volume"] == q["volume"] and q["volume"] is not None]
        chosen = (same_vol or pool)[0] if (same_vol or pool) else None

        # 置信度：靠证据堆，不靠感觉
        confidence = "low"
        reasons = []
        if chosen is None:
            pairs.append({"question": q["file"], "answer": None, "confidence": "none", "reasons": ["没有可配对的解析文件"]})
            continue
        used.add(chosen["file"])

        if chosen["base"] == q["base"]:
            reasons.append("文件名主干相同")
        if q["volume"] is not None and chosen["volume"] == q["volume"]:
            reasons.append(f"分册标记一致（{q['volume']}）")
        if q["set_range"] and chosen["set_range"]:
            if q["set_range"] == chosen["set_range"]:
                reasons.append(f"目录套号区间一致（{q['set_range'][0]}–{q['set_range'][1]}）")
                confidence = "high"
            else:
                reasons.append(f"目录套号区间不一致：题本{q['set_range']} vs 解析{chosen['set_range']}")
        elif q["set_range"] or chosen["set_range"]:
            reasons.append("只有一侧有目录，无法交叉核对")

        # 题号交叉：两端题号应当有交集或衔接
        qn, an = q["question_numbers_seen"], chosen["question_numbers_seen"]
        if qn and an:
            inter = set(qn) & set(an)
            reasons.append(f"已 OCR 页的题号交集 {len(inter)} 个（题本 {len(qn)} 个 / 解析 {len(an)} 个）")
            if inter:
                confidence = "high" if confidence == "high" else "medium"
        else:
            reasons.append("题号证据不足（OCR 页太少）")

        pairs.append(
            {
                "question": q["file"],
                "answer": chosen["file"],
                "base": q["base"],
                "volume": q["volume"],
                "question_set_range": q["set_range"],
                "answer_set_range": chosen["set_range"],
                "confidence": confidence,
                "reasons": reasons,
            }
        )

    unpaired_answers = [a["file"] for a in answers if a["file"] not in used]

    report = {
        "dir": os.path.abspath(args.dir),
        "files": [{k: v for k, v in f.items() if k != "path"} for f in files],
        "classified": {
            "题本": [f["file"] for f in questions],
            "解析": [f["file"] for f in answers],
            "未识别": [f["file"] for f in others],
        },
        "pairs": pairs,
        "unpaired_answers": unpaired_answers,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    # stdout 只打 ASCII 摘要（控制台编码不可靠）
    print(f"dir: {os.path.basename(args.dir)}")
    print(f"files: {len(files)}  questions={len(questions)} answers={len(answers)} unrecognized={len(others)}")
    for p in pairs:
        print(f"  PAIR {p['confidence']:<6} vol={p['volume']} q_sets={p['question_set_range']} a_sets={p['answer_set_range']}")
        print(f"       Q: {p['question']}")
        print(f"       A: {p['answer']}")
    if others:
        print(f"  UNRECOGNIZED: {[f['file'] for f in others]}")
    if unpaired_answers:
        print(f"  UNPAIRED ANSWERS: {unpaired_answers}")
    print(f"\nJSON: {args.out}")
    print("NOTE: this script only PROPOSES the pairing. Nothing is OCR'd or imported here.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
