"""把多份抽取结果合并成一个题库 —— 所以"题库可以有多个来源"。

═══ 为什么需要这个脚本 ═══
`build_bank.py` 一次只处理一份抽取结果。而题库是**跨资料**的：
现在有片段阅读（言语理解）与逻辑判断两份，将来会有更多。
所以要有一步把多份合并起来，而不是每次覆盖。

═══ 一个必须守住的约束：**已有题的 id 不能变** ═══
作者已经在片段阅读那 20 题上刷过题了，作答事件里记着它们的 id。
如果合并时重算 id 导致变化，那些作答题就会**指向不存在的题**——
历史数据静默失效，而且从题库上看不出来。

所以合并策略是：
  · 已有题库里的题**原样保留**（连 id 一起）；
  · 新抽取的题按同一算法派生 id；
  · **id 冲突时报出来**，不静默覆盖（冲突意味着两处抽到了同一道题，
    或者 id 算法在该资料上区分度不够——两者都该让人知道）。

用法:
  D:\\miniconda\\python.exe scripts/merge_banks.py \\
      --existing "<工作区>\\lh-questions\\片段阅读600题.json" \\
      --add-extracted data/align/lj-extracted.json \\
      --source-file "逻辑判断600题题本篇.pdf" --source-root "D:\\考公资料" \\
      --out data/bank-merged/题库.json
"""

import argparse
import hashlib
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

PUNCT = "，。、；：？！“”‘’（）《》【】…—·,.;:?!\"'()[]<>-_\u3000"


def fingerprint(text):
    """题干指纹。与 `question.js` 的 fingerprintStem 同源（只用于离线校验 id 稳定性）。"""
    t = text
    for ch in PUNCT:
        t = t.replace(ch, "")
    return re.sub(r"\s+", "", t)


def derive_id(source_file, number, stem):
    """与 `question.js` 的 deriveQuestionId 同一算法。"""
    canonical = "|".join(["", source_file, str(number), fingerprint(stem)[:40]])
    return "q-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]


def clean_analysis(item):
    """决定讲解放什么。与 `build_bank.py` 保持同一口径（占位不冒充讲解）。"""
    body = (item.get("analysis") or "").strip()
    notes = item.get("wrong_option_notes") or {}
    ans = (item.get("answer") or [""])[0]
    if item.get("analysis_is_placeholder") or len(body) < 20:
        if notes and len(notes) >= 2:
            parts = "；".join(f"{k}项{v}" for k, v in sorted(notes.items()) if v)
            return f"正确选项为{ans}项。其余选项的标注：{parts}。（本条由选项标注拼成，非原文讲解）"
        return ""
    return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--existing", help="已有题库（其中的题原样保留，id 不变）")
    ap.add_argument("--add-extracted", action="append", default=[], help="要加入的抽取结果（可多次给）")
    ap.add_argument("--source-file", action="append", default=[], help="与 --add-extracted 一一对应的源文件名")
    ap.add_argument("--source-root", default=None)
    ap.add_argument("--title", default=None)
    ap.add_argument("--min-confidence", default="medium", choices=["high", "medium", "low"])
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    order = {"high": 3, "medium": 2, "low": 1, "none": 0}
    floor = order[args.min_confidence]

    questions = []
    seen_ids = {}
    skipped = []

    # ── 1. 已有题库原样进来 ──
    if args.existing:
        with open(args.existing, encoding="utf-8") as fh:
            old = json.load(fh)
        for q in old.get("questions", []):
            questions.append(q)
            seen_ids[q["id"]] = f"{q.get('source', {}).get('path')}#{q.get('source', {}).get('number')}"

    # ── 2. 新抽取的题 ──
    for i, path in enumerate(args.add_extracted):
        source_file = args.source_file[i] if i < len(args.source_file) else os.path.basename(path)
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        added = 0
        for e in data["items"]:
            conf = e.get("confidence", "none")
            if order.get(conf, 0) < floor:
                skipped.append({"file": source_file, "set": e.get("set"), "no": e.get("no"), "conf": conf, "reason": e.get("reason") or "置信度不足"})
                continue
            if not e.get("answer") or not (e.get("stem") or "").strip():
                skipped.append({"file": source_file, "set": e.get("set"), "no": e.get("no"), "conf": conf, "reason": "无答案或题干"})
                continue

            stem = e["stem"].strip()
            # 题号带套号：套内题号会重复
            number = f"set{e['set']}-q{e['no']}" if e.get("set") is not None else f"q{e['no']}"
            qid = derive_id(source_file, number, stem)

            if qid in seen_ids:
                skipped.append({"file": source_file, "set": e.get("set"), "no": e.get("no"), "conf": conf, "reason": f"id 冲突（与 {seen_ids[qid]}）"})
                continue
            seen_ids[qid] = f"{source_file}#{number}"

            options = [o["text"] for o in (e.get("options") or [])]
            analysis = clean_analysis(e)
            questions.append(
                {
                    "id": qid,
                    "kind": "single_choice" if len(options) >= 2 else "fill_blank",
                    "stem": stem,
                    "options": options,
                    "answer": e["answer"],
                    "analysis": analysis,
                    "topics": [],
                    "source": {
                        "resource_ref": None,
                        "path": source_file,
                        "number": number,
                        "page": e.get("question_page"),
                    },
                    "provenance": {
                        "plugin": "@lh/extractor",
                        "version": "0.0.1",
                        "method": "rule:【参考答案】+双信号校验",
                        "source_answer_file": data.get("answer_file"),
                        "confidence": conf,
                        "question_type": e.get("question_type"),
                        "analysis_available": analysis != "",
                        "analysis_kind": "原文" if (analysis and not analysis.endswith("（本条由选项标注拼成，非原文讲解）")) else ("选项标注拼成" if analysis else "无"),
                    },
                }
            )
            added += 1
        print(f"  {source_file}: 加入 {added} 题，跳过 {len([s for s in skipped if s['file'] == source_file])} 题")

    # 结构警告：有题干无选项的题（页眉切断），单独报出来
    no_options = [q for q in questions if len(q.get("options") or []) < 2]
    if no_options:
        print(f"\n⚠ 有 {len(no_options)} 道题没有选项（可能是页眉切断了题块）：")
        for q in no_options:
            print(f"    {q['source']['path']} {q['source']['number']}  {q['stem'][:40]}")

    bank = {
        "schema_version": 1,
        "title": args.title or "考公-言语理解与逻辑判断",
        "source_root": args.source_root,
        "generated_at": "2026-09-17T15:00:00.000Z",
        "provenance": {"plugin": "@lh/extractor", "version": "0.0.1", "extraction": "rule", "merged": True},
        "question_count": len(questions),
        "duplicate_ids": [],
        "questions": questions,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(bank, fh, ensure_ascii=False, indent=2)

    # 按来源统计
    bysrc = {}
    for q in questions:
        k = q["source"]["path"] or "(无来源)"
        bysrc[k] = bysrc.get(k, 0) + 1
    print(f"\n合并后共 {len(questions)} 题：")
    for k, v in bysrc.items():
        print(f"  {v:>3} 题  来自 {k}")
    print(f"\n写出 {args.out}")
    if skipped:
        print(f"\n跳过 {len(skipped)} 题：")
        for s in skipped:
            print(f"  {os.path.basename(str(s['file']))} set={s['set']} q={s['no']} conf={s['conf']} {s['reason']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
