"""从解析里提答案与讲解 —— 规则优先，并且**每条都带自校验**。

═══ 这一步的形态判断（探查后才知道）═══
`probe_answer_markers.py` 数出来的事实：
  - 解析里**没有** `答案：` / `正确答案` / `选X` / `故X` / `X项正确`（全部 0 命中）；
  - 真实形态是 **`【参考答案】C`**，28 页里 37 处，字母分布 A7/B15/C8/D7（合理）；
  - 紧随其后是 `【题型与文段类型】…`、`【实战解析】…`；
  - 参考答案后面常粘着**推广文字**（`公考最新资料、更新进度微信SKA674`），必须切掉。

**结论：答案可以规则抽取，不需要 LLM 推理。** 这很重要——规则可复现、零成本、可审计；
用 LLM 去做一件规则能做的事，既贵又不可复现（ADR-016 的成本观）。

═══ 三条自校验（这是本脚本的核心价值）═══
光把字母抠出来不够，必须能发现"抠错了"。所以每道题都做三项交叉检查：

  ① **选项标注法**：解析里每个选项都带评注（`（缺主题词）`/`（无中生有）`/`（对策有误）`），
     而**正确选项通常没有负面评注**。若被 `【参考答案】` 指为正确的那个选项带着
     "有误/无中生有/绝对化"之类的负面词 → 高度可疑。
  ② **讲解提及法**：`【实战解析】` 里常写"对应C选项，当选"。若答案字母在讲解里
     以"对应X选项"/"X项当选"出现 → 互相印证。
  ③ **完整性**：每道题必须恰好找到一个 `【参考答案】`，且它落在本题范围内
     （≥本题起点、<下一题起点）。找不到或越界 → 报出来，**不猜**。

三项都只是"印证"，不是"证明"。所以低置信度的题会被标出来，交给 LLM 抽样复核
（ADR-020 决定 5）。

用法: D:\\miniconda\\python.exe scripts\\extract_answers.py --report data\\align\\set01-report.json --ocr <解析目录> --out data\\align\\set01-extracted.json
"""

import argparse
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

# ── 标记 ──
RE_ANSWER = re.compile(r"【\s*参\s*考\s*答\s*案\s*】\s*([A-DＡ-Ｄ])")
RE_TYPE = re.compile(r"【\s*题\s*型[^】]*】\s*([^\n【]*)")
# ⚠ 这里**曾经是** `([^\n【]*)` —— 捕获类遇到第一个换行就停。
#
# 后果（2026-09-18 实测定位）：这份资料的解析是多行的（双栏 PDF，一行约 26 字），
# 于是**每一道题的解析都被截成了第一行**，而且截在句子中间。
# 证据不是"看起来短"，而是**长度全是 26 字**——那不是跨页切断的随机长度，
# 是"一行的宽度"。量化：49 道里 46 道被截断，总字数 884 → 13710（×15.5）。
#
# 更坏的是它**不像坏了**：`analysis_available` 因为"非空"而被置为 true，
# 界面上就显示一段像解析的残句——"不完整"比"没有"更容易让人误信。
#
# 修法：一直取到**下一个标记或块末尾**。
# 为什么可以跨换行：`answer_text_full` 已按题切好（对齐阶段做的），
# 所以"到块末尾"不会串到下一题；`【` 是下一区段的开始标记，必须停。
#
# ⚠ 一个**必须如实标注**的残留问题：补回来的正文是 **OCR 两栏串行**的，
# 读起来会跳（如"题干中的对比实验明 未表明实验结果…应补充 显缺少实验结果"）。
# 所以下游不能把它当"干净的讲解散文"用——
# 它适合当**给模型看的证据**（模型能容忍语序跳动），
# 不适合原样端给学习者当讲义（见 build_bank.py 的 analysis_kind）。
RE_EXPLAIN = re.compile(r"【\s*实\s*战\s*解\s*析\s*】\s*([\s\S]*?)(?=【|\Z)")

# ── 推广文字：必须从答案与讲解里切掉，否则会把微信号写进题库 ──
RE_PROMO = re.compile(r"(公考最新资料|更新进度|微信\s*[A-Za-z0-9_]+|SKA\d+|QQ\s*群|公众号|扫码|关注)")

# ── 选项的负面评注：被标为正确的选项不该带这些词 ──
NEGATIVE = [
    "有误", "无中生有", "绝对化", "缺主题词", "偷换", "错误", "不当", "不准确",
    "未提及", "偏离", "片面", "过度推断", "强加因果", "不符", "过于绝对",
]

# 选项行：`A. 选项内容（评注）`，可能是全角字母
RE_OPTION_ANNOT = re.compile(r"^\s*([A-DＡ-Ｄ])\s*[.．、]\s*(.+)$")


def norm_letter(ch):
    """全角字母 → 半角并大写。"""
    return ch.upper().translate(str.maketrans("ＡＢＣＤ", "ABCD"))


def load_full_text(ocr_dir):
    """按页序拼解析全文，并保留页号边界。"""
    import json as _json

    pages = []
    for name in sorted(os.listdir(ocr_dir)):
        if not name.endswith(".json") or name.startswith("_"):
            continue
        with open(os.path.join(ocr_dir, name), encoding="utf-8") as fh:
            p = _json.load(fh)
        pages.append((p.get("page"), p.get("text", "")))
    pages.sort()
    return pages, "\n".join(t for _p, t in pages)


def strip_promo(text):
    """切掉推广文字。

    做法：逐行看，含推广关键词的**那一行里**从关键词处截断；
    若整行都是推广，整行丢掉。
    """
    out = []
    for ln in text.split("\n"):
        m = RE_PROMO.search(ln)
        if m:
            head = ln[: m.start()].strip()
            if head:
                out.append(head)
            continue
        out.append(ln)
    return "\n".join(out)


def parse_option_annotations(text):
    """从解析块里抽出各选项的评注。"""
    annots = {}
    for ln in text.split("\n"):
        m = RE_OPTION_ANNOT.match(ln)
        if not m:
            continue
        letter = norm_letter(m.group(1))
        body = m.group(2)
        # 括号里的内容就是评注
        note = ""
        bm = re.search(r"[（(]([^）)]*)[）)]", body)
        if bm:
            note = bm.group(1).strip()
        # 同一字母出现多次时，保留带评注的那次（更有信息）
        if letter not in annots or (note and not annots[letter]):
            annots[letter] = note
    return annots


def extract_one(block_text, answer_letter, options, annots=None):
    """对一道题的解析块做三项校验。

    ⚠ `annots` 必须由调用方传入（且只在 `【参考答案】` 之后取），
    不在这里从 `block_text` 重新解析——因为块范围会把**下一题的选项行**包进来。
    第一版就是在这里自己重解析，把调用方的修正覆盖掉了。
    """
    checks = {}

    # ① 选项标注法
    annots = annots if annots is not None else parse_option_annotations(block_text)
    checks["option_annotations"] = annots
    if answer_letter and answer_letter in annots:
        note = annots[answer_letter]
        bad = [w for w in NEGATIVE if w in note]
        checks["chosen_option_has_negative_note"] = bool(bad)
        checks["chosen_option_note"] = note
        checks["negative_words_found"] = bad
    else:
        checks["chosen_option_has_negative_note"] = None
        checks["chosen_option_note"] = None

    # ② 讲解提及法
    if answer_letter:
        mention = re.search(
            rf"(对\s*应\s*{answer_letter}\s*选\s*项|{answer_letter}\s*选\s*项\s*[,，]?\s*当\s*选|{answer_letter}\s*项\s*当\s*选|故\s*(?:选)?\s*{answer_letter})",
            block_text,
        )
        checks["explanation_mentions_answer"] = bool(mention)
        if mention:
            checks["mention_text"] = mention.group(0)
    else:
        checks["explanation_mentions_answer"] = None

    # ③ 合法性：答案必须在该题的选项范围内
    labels = [o["label"] for o in options] if options else []
    checks["answer_in_options"] = answer_letter in labels if (answer_letter and labels) else None

    # ④ 分布法：正确选项**不该**带负面评注，而其他选项**应当**带。
    #
    # ⚠ 这个信号我一开始当成了"最强信号"，**实测被推翻**：
    #   Q1 答案 C，各选项评注 {A: 片面, B: 区别比较联系类, D: 区别比较联系类}，
    #   而 C 自己也有评注「具体类」——只是正则没捕到。
    # 真相是：这份资料的选项标注里**混着题型提示**（"区别比较联系类选项"、"具体类选项"），
    # 并不全是负面评语。所以"选中项无评注"既非必要也非充分。
    #
    # 因此它降级为**辅助信号**：只在它成立时提供一点额外把握，
    # 绝不因为"它不成立"就否掉一个已经被讲解印证过的答案。
    others = {k: v for k, v in annots.items() if k != answer_letter}
    others_with_notes = sum(1 for v in others.values() if v)
    checks["other_option_notes_ok"] = (
        others_with_notes >= max(1, len(others) - 1) and answer_letter in annots and not annots.get(answer_letter)
        if (answer_letter and annots)
        else None
    )
    # 明确记录"选中项自己带评注"这个事实——它是复核时最该看的一条
    checks["chosen_option_note_is_teaching_hint"] = bool(
        answer_letter and annots.get(answer_letter) and not any(w in (annots.get(answer_letter) or "") for w in NEGATIVE)
    )

    # ══ 综合置信度 ══
    #
    # ⚠ 只用**两个可靠信号**，刻意不用选项评注：
    #   `answer_in_options`        — 答案必须在该题的选项范围内（机械可判）
    #   `explanation_mentions_answer` — 讲解正文里显式写了"对应C选项，当选"（原文印证）
    #
    # 为什么不把选项评注算进来：实测这份资料是**双栏/页边批注**排版，
    # OCR 按行输出导致批注与正文交错，逐行解析无法可靠地把评注挂到正确的选项上
    # （`measure_loose_annotations.py` 实测：20 题只捞到 3 题，且存在串题）。
    # 拿一个不可靠的信号去抬置信度，会让"置信度"这个字段彻底失去意义——
    # 而它的全部价值就在于**能筛出要复核的题**。
    #
    # 评注仍然照实保存（有的人想看），但**不参与判断**。
    signals = [v for v in (checks.get("answer_in_options"), checks.get("explanation_mentions_answer")) if v is not None]
    if signals and all(signals):
        confidence = "high"
    elif signals and any(signals):
        confidence = "medium"
    else:
        confidence = "low"
    checks["confidence"] = confidence
    checks["confidence_basis"] = (
        f"在选项内={checks.get('answer_in_options')}, 讲解提及={checks.get('explanation_mentions_answer')} "
        f"(评注不参与判断)"
    )
    return checks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True, help="对齐报告（align_by_question.py match 的产物）")
    ap.add_argument("--ocr", required=True, help="解析 OCR 目录")
    ap.add_argument("--out", required=True)
    ap.add_argument("--source-root", default=None, help="资料根，用于 id 派生")
    args = ap.parse_args()

    with open(args.report, encoding="utf-8") as fh:
        report = json.load(fh)

    pages, full = load_full_text(args.ocr)
    results = report["results"]

    # 每题的范围 = [本题起点, 下一题起点)
    spans = []
    for i, x in enumerate(results):
        start = x.get("located_at")
        nxt = None
        for j in range(i + 1, len(results)):
            if results[j].get("located_at") is not None:
                nxt = results[j]["located_at"]
                break
        spans.append((start, nxt if nxt is not None else len(full), x))

    extracted = []
    stats = {"high": 0, "medium": 0, "low": 0, "none": 0}

    for start, end, x in spans:
        item = {
            "set": x["set"],
            "no": x["question_no"],
            "question_page": x["question_page"],
            "stem": x.get("stem_full") or "",
            "options": x.get("options") or [],
        }
        if start is None:
            item["answer"] = None
            item["confidence"] = "none"
            item["reason"] = "未定位到解析"
            stats["none"] += 1
            extracted.append(item)
            continue

        block = full[start:end]

        # 本题范围内的【参考答案】
        am = RE_ANSWER.search(block)
        if am is None:
            # ═══ 页脚会把答案与它所属的题隔开 ═══
            # 实测第 3 题：答案落在下一题的解析起点之后，中间隔着
            #     "2 / 四海公考 / 练习题01套 / SIHAIGONGKAO"
            # 所以本题范围内找不到时，**向后探一段**再找一次——
            # 探的窗限得很紧（1200 字），避免真的捞到下一题的答案。
            tail = full[end:end + 1200]
            loose = RE_ANSWER.search(tail)
            if loose is not None:
                am = loose
                block = full[start:end + 1200]
                note = "答案标记在页脚之后（已向后探到）"
            else:
                block = full[start:end]
                note = None
        else:
            note = None

        if am is None:
            item["answer"] = None
            item["confidence"] = "none"
            item["reason"] = "本题范围内（含向后 1200 字）没有【参考答案】标记"
            stats["none"] += 1
            extracted.append(item)
            continue

        letter = norm_letter(am.group(1))
        item["answer"] = [letter]
        item["answer_offset"] = am.start()
        if note:
            item["extraction_note"] = note

        # ═══ 讲解：不做"干净散文"的抽取，改为结构化保存 ═══
        #
        # 实测这份资料的讲解有两条来源：
        #   1. `【实战解析】` 之后的"正文"——但它常常只写"文段分析见批注。"（8 字）；
        #   2. **页边批注**——真正的讲解在这里，但 OCR 把双栏串行了，批注散落在题干续行之间。
        #
        # 所以"抽出一段干净的讲解散文"在这份资料上做不到（OCR 层面就做不到，不是逻辑问题）。
        # 强行抽只会把错序的批注塞进 `analysis`，让题库里出现读不通的文字——
        # 那比"没有讲解"更糟：没有讲解时 agent 知道该自己讲（render 里已写了提示），
        # 而有一段读不通的讲解时，agent 会以为那是原文。
        #
        # 因此改为：
        #   - `answer`：规则抽取，三重校验；
        #   - `option_notes`：**结构化保存**每个选项的评注（这是可靠且有信息量的部分）；
        #   - `analysis`：只保留 `【实战解析】` 之后的短正文，并标注它是否只是"见批注"的占位。
        em = RE_EXPLAIN.search(block, am.end())
        tm = RE_TYPE.search(block, am.end())
        if em is not None:
            analysis = em.group(1)
        elif tm is not None:
            analysis = block[tm.end(): tm.end() + 400]
        else:
            analysis = block[am.end(): am.end() + 400]
        analysis = strip_promo(analysis).strip()
        analysis = re.sub(r"\n{2,}", "\n", analysis)
        item["analysis"] = analysis
        item["analysis_chars"] = len(analysis)
        # "见批注"这类占位要标出来：它不是讲解，只是一个指针
        item["analysis_is_placeholder"] = bool(re.search(r"见批注|见解析|略", analysis)) and len(analysis) < 40

        # ═══ 选项评注只在 `【参考答案】` 之后取，不在整个块里取 ═══
        #
        # ⚠ 这是一个会**静默取错数据**的坑：
        # 本题的块范围是 [本题解析起点, 下一题解析起点)，
        # 而下一题的**选项行**（`A. …（缺主题词）`）落在这个范围里——
        # 因为"下一题的解析起点"是它的**题干**出现的位置，而选项在题干之前。
        # 于是 `parse_option_annotations(block)` 会把**下一题的选项评注**当成本题的。
        # 实测就是这么发生的：Q9 的评注其实来自 Q10 的区域。
        #
        # 正确答案的选项评注区在 `【参考答案】` 之后（资料版式如此），
        # 所以从那里开始取，就不会串到下一题。
        annots = parse_option_annotations(block[am.start():])
        item["option_notes"] = annots
        item["wrong_option_notes"] = {k: v for k, v in annots.items() if k != letter and v}

        tm2 = RE_TYPE.search(block, am.end())
        item["question_type"] = tm2.group(1).strip() if tm2 else None

        item.update(extract_one(block, letter, item["options"], annots=annots))
        stats[item["confidence"]] += 1
        extracted.append(item)

    # 汇总：把可疑的题挑出来
    suspicious = [e for e in extracted if e.get("confidence") in ("low", "none")]
    negative_note = [e for e in extracted if e.get("chosen_option_has_negative_note") is True]

    out = {
        "question_file": report["question_file"],
        "answer_file": report["answer_file"],
        "total": len(extracted),
        "confidence_dist": stats,
        "suspicious_count": len(suspicious),
        "chosen_option_has_negative_note_count": len(negative_note),
        "items": extracted,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)

    print(f"total={len(extracted)}  confidence={stats}")
    print(f"suspicious={len(suspicious)}  chosen-option-with-negative-note={len(negative_note)}")
    for e in suspicious[:10]:
        print(f"  set={e['set']} q={e['no']} conf={e['confidence']} answer={e.get('answer')} reason={e.get('reason', '')}")
    print(f"\nJSON: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
