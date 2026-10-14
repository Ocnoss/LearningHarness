"""把提取结果装成题库 JSON（可直接交给 import_questions 入库）。

═══ 字段分工（依据 ADR-020 决定 4）═══
  - `stem` / `options` ← **只从题本取**。解析里也含题干，但批注插在句子中间，
    两边各取一次再合并会得到两段不同的噪声文本，且无法判断该信哪个。
  - `answer` / `analysis` / `question_type` / `confidence` ← 从解析取。

═══ 为什么还产出标注文件与报表 ═══
  - `option_notes` 是这份资料**最有教学价值**的部分（"A 缺主题词、B 无中生有、D 片面"），
    但题库 schema 里没有这个字段。直接塞进 `analysis` 会把结构化数据变成散文，
    所以另存一个**配套文件**，题库保持干净可迁移。
  - 报表记录每题的三项校验信号与置信度，供抽样复核（ADR-020 决定 5）。

用法:
  D:\\miniconda\\python.exe scripts\\build_bank.py --extracted data\\align\\set01-extracted.json --out <工作区>\\lh-questions\\片段阅读600题.json --stamp 2026-09-17
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
    """题干指纹：去空白、标点映射掉。必须与 question.js 的 fingerprintStem 同源。

    ⚠ 两处实现同一规则是有风险的（会漂移）。这里刻意只用于**校验**——
    真正的 id 由插件侧的 deriveQuestionId 派生。本脚本算一遍是为了在离线阶段
    就能发现"同一个题库里出现重复 id"这类问题，而不是等到入库时才炸。
    """
    t = text
    for ch in PUNCT:
        t = t.replace(ch, "")
    return re.sub(r"\s+", "", t)


def derive_id(source_file, number, stem):
    """与 question.js 的 deriveQuestionId 保持同一算法。"""
    canonical = "|".join(["", source_file, str(number), fingerprint(stem)[:40]])
    return "q-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]


def clean_analysis(item):
    """决定 `analysis` 放什么。

    ⚠ 作者定的一个取舍：讲解**不假装完整**。

    实测这份资料的讲解有两条来源，两条都拿不干净：
      1. `【实战解析】` 之后的正文常常只写"文段分析见批注。"（8 字，是**指针不是内容**）；
      2. **页边批注**才是真正的讲解，但资料是双栏排版，OCR 按行输出导致批注与正文交错，
         逐行解析无法可靠地把批注挂到正确的题上（实测 20 题只捞回 3 题，且会串题）。

    所以这里：
      - **不把错序的批注硬塞进 `analysis`** —— 一段读不通的"讲解"比没有讲解更糟，
        因为 agent 会以为那是原文；
      - 有可靠的选项评注时才拼一句可读的说明（并如实注明是拼的）；
      - 其余情况**留空**，由 `provenance.analysis_available` 标明"该题无可靠讲解"，
        agent 据 render 里的提示自己去讲。

    这个损失**不影响判分**：答案是从 `【参考答案】` 直接抽的，判分/错题本/覆盖率都不依赖讲解。
    """
    body = (item.get("analysis") or "").strip()
    notes = item.get("wrong_option_notes") or {}
    ans = (item.get("answer") or [""])[0]

    if item.get("analysis_is_placeholder") or len(body) < 20:
        # 只在评注**确实是这道题的**时候才用它拼——过短的块容易串到下一题
        if notes and len(notes) >= 2:
            parts = "；".join(f"{k}项{v}" for k, v in sorted(notes.items()) if v)
            return f"正确选项为{ans}项。其余选项的标注：{parts}。（本条由选项标注拼成，非原文讲解）"
        return ""
    return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extracted", required=True)
    ap.add_argument("--out", required=True, help="题库 JSON 输出路径")
    ap.add_argument("--source-file", default=None, help="资料内文件路径（参与 id 派生）")
    ap.add_argument("--source-root", default=None)
    ap.add_argument("--title", default=None)
    ap.add_argument("--stamp", default=None, help="generated_at 用（固定值便于复现）")
    ap.add_argument("--min-confidence", default="medium", choices=["high", "medium", "low"],
                    help="低于这一档的题不入库（默认 medium：排除 low 与 none）")
    args = ap.parse_args()

    with open(args.extracted, encoding="utf-8") as fh:
        data = json.load(fh)

    order = {"high": 3, "medium": 2, "low": 1, "none": 0}
    floor = order[args.min_confidence]

    source_file = args.source_file or data.get("question_file") or "未知题本"
    questions = []
    skipped = []
    sidecar_notes = {}
    report_rows = []

    for e in data["items"]:
        conf = e.get("confidence", "none")
        if order.get(conf, 0) < floor:
            skipped.append({"set": e["set"], "no": e["no"], "confidence": conf, "reason": e.get("reason")})
            continue
        answer = e.get("answer")
        if not answer:
            skipped.append({"set": e["set"], "no": e["no"], "confidence": conf, "reason": "无答案"})
            continue

        stem = (e.get("stem") or "").strip()
        if not stem:
            skipped.append({"set": e["set"], "no": e["no"], "confidence": conf, "reason": "无题干"})
            continue
        options = [o["text"] for o in (e.get("options") or [])]

        # 题号带上套号：套内题号会重复（实测每套都从 1 开始），
        # 只用套内题号会让 id 在同一个文件里撞车。
        number = f"set{e['set']}-q{e['no']}"
        qid = derive_id(source_file, number, stem)
        analysis = clean_analysis(e)

        q = {
            "id": qid,
            "kind": "single_choice" if len(options) >= 2 else "fill_blank",
            "stem": stem,
            "options": options,
            "answer": answer,
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
                # 抽取**未经 LLM**，是规则抽取：记下来，让人知道这条不是模型判断的产物
                "method": "rule:【参考答案】+双信号校验",
                "source_answer_file": data.get("answer_file"),
                "confidence": conf,
                "question_type": e.get("question_type"),
                # 讲解是否可用，显式记下来（见 clean_analysis 的注释）。
                # 为什么不用"analysis 为空"来表达：空字符串无法区分
                # "这道题本来就没讲解"与"抽取失败"——而这两者该有不同处置。
                "analysis_available": analysis != "",
                "analysis_kind": (
                    "原文" if (analysis and not analysis.endswith("（本条由选项标注拼成，非原文讲解）"))
                    else ("选项标注拼成" if analysis else "无")
                ),
            },
        }
        questions.append(q)
        if e.get("option_notes"):
            sidecar_notes[qid] = {"option_notes": e["option_notes"], "chosen": answer[0]}
        report_rows.append({
            "id": qid, "set": e["set"], "no": e["no"], "answer": answer,
            "confidence": conf, "basis": e.get("confidence_basis"),
            "question_type": e.get("question_type"),
            "answer_in_options": e.get("answer_in_options"),
            "explanation_mentions_answer": e.get("explanation_mentions_answer"),
            "other_option_notes_ok": e.get("other_option_notes_ok"),
            "chosen_option_note": e.get("chosen_option_note"),
            "chosen_option_has_negative_note": e.get("chosen_option_has_negative_note"),
            "extraction_note": e.get("extraction_note"),
        })

    # id 去重自检：同一个题库里出现重复 id 说明 id 规则在这个文件上不够区分
    ids = [q["id"] for q in questions]
    dupes = sorted({i for i in ids if ids.count(i) > 1})

    bank = {
        "schema_version": 1,
        "title": args.title or "片段阅读600题",
        "source_root": args.source_root,
        "generated_at": args.stamp or "2026-09-17T00:00:00.000Z",
        "provenance": {
            "plugin": "@lh/extractor",
            "version": "0.0.1",
            "answer_file": data.get("answer_file"),
            "extraction": "rule",
        },
        "question_count": len(questions),
        "duplicate_ids": dupes,
        "questions": questions,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(bank, fh, ensure_ascii=False, indent=2)

    sidecar_path = os.path.join(os.path.dirname(args.out), os.path.basename(args.out).replace(".json", ".option-notes.json"))
    with open(sidecar_path, "w", encoding="utf-8") as fh:
        json.dump({"for_bank": os.path.basename(args.out), "notes": sidecar_notes}, fh, ensure_ascii=False, indent=2)

    report_path = os.path.join(os.path.dirname(args.out), os.path.basename(args.out).replace(".json", ".extract-report.json"))
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump({"rows": report_rows, "skipped": skipped}, fh, ensure_ascii=False, indent=2)

    print(f"bank: {args.out}")
    print(f"  questions={len(questions)}  skipped={len(skipped)}  duplicate_ids={len(dupes)}")
    print(f"  sidecar(option notes): {sidecar_path}  ({len(sidecar_notes)} 题有评注)")
    print(f"  report: {report_path}")
    if dupes:
        print(f"  ⚠ DUPLICATE IDS: {dupes[:5]}")
    for s in skipped:
        print(f"  skipped set={s['set']} q={s['no']} conf={s['confidence']} {s.get('reason') or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
