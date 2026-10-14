"""按**题目序号**对齐题本与解析，逐题做对应并抽样校验。

═══ 作者纠正了一个真缺陷 ═══
我的上一版打算"两个文件各取第 3–12 页"来对齐。那是错的：
**解析每题的篇幅比题本长得多**（题本 94 页装 300 题，解析 212 页装同样 300 题），
所以"同样的页数"覆盖的题数不同，第 N 页的题本内容对不上第 N 页的解析内容。

正确做法：**对齐的单位是题目，不是页**。页数只是冗余——
题本 20 题可能占 6 页，解析 20 题可能占 15 页，那就各读到够 20 题为止。

═══ 对齐的键：题号，而不是位置 ═══
两个文件都在每套开头印 `练习题NN套`，套内题号从 1 重新开始。
所以"第几套 + 套内第几题"是**两边都印出来的**稳定键。
用它对齐比用页面位置可靠得多：位置会因排版差异漂移，而印出来的题号不会。

═══ 校验用题干本身 ═══
对齐之后必须验：解析里那一块讲的，确实是题本里的那道题。
判据是**题干文字**——取题本题干的前若干字（去掉空白与标点），
看它是否出现在配对到的解析块里。这比"题号看起来对"强得多：
题号可能因为漏识别而错位，而题干文字对不上就一定错了。

用法:
  # 1) 先按题取页（题本 N 题、解析 M 题，页数各自读够为止）
  D:\\miniconda\\python.exe scripts\\align_by_question.py plan --dir "<资料夹>" --set 1 --questions 20 --out data\\align\\set01
  # 2) 跑 OCR（用 ocr_pages.py，页清单由本脚本生成）
  # 3) 再对齐并校验
  D:\\miniconda\\python.exe scripts\\align_by_question.py match --plan data\\align\\set01\\plan.json --ocr <目录> ...
"""

import argparse
import json
import os
import re
import sys

import pymupdf

# OCR 的常见噪声：汉字间被插空格、全角/半角混用。
# 做包含判断前必须归一化，否则"题干文字对得上"会因为一个空格判定失败。
PUNCT = "，。、；：？！“”‘’（）《》【】…—·,.;:?!\"'()[]<>-_\u3000"


def normalize(text):
    """把文本压成可做包含判断的形式：去空白、去标点、统一引号。"""
    t = text
    for ch in PUNCT:
        t = t.replace(ch, "")
    return re.sub(r"\s+", "", t)


def load_pages(ocr_dirs):
    """读多个 OCR 目录 → {normcase(pdf路径): {页码: payload}}。"""
    by_pdf = {}
    for d in ocr_dirs:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".json") or name.startswith("_"):
                continue
            with open(os.path.join(d, name), encoding="utf-8") as fh:
                payload = json.load(fh)
            pdf = payload.get("pdf")
            page = payload.get("page")
            if not pdf or not page:
                continue
            by_pdf.setdefault(os.path.normcase(os.path.abspath(pdf)), {})[page] = payload
    return by_pdf


# ── 结构解析 ──

RE_SET = re.compile(r"练\s*习\s*题\s*(\d{1,3})\s*套?")
RE_QNUM = re.compile(r"^\s*(\d{1,3})\s*[.．、]\s*(.*)$")
RE_OPTION = re.compile(r"^\s*([A-DＡ-Ｄ])\s*[.．、]\s*(.*)$")

# ⚠ 上面 RE_SET 里的"套"字**必须可选**，这是一个踩过的坑：
#     片段阅读的套头是 `练习题01套`（带"套"字）
#     逻辑判断的套头是 `练习题01`  （**不带"套"字**，页眉只有编号）
#   第一版只认带"套"字的，于是逻辑判断的套号**识别不出来**，
#   分块的键从 `(套号, 题号)` 退化成 `(None, 题号)`。
#   而每套的题号都从 1 重启 —— 去重就把第 2 套整批删掉了：
#   实测 43 个块被压成 20 个，而"第 1 套恰好 20 题"让这个数字**看起来完全正常**，
#   极易被误读成"这份文件只有 20 题"。
#
#   与 ADR-017 决定 2 一脉相承，但要再补一句：
#   **键的构成一旦退化，退化是静默的** —— 它不会报错，只会少给你数据。
#   所以"块数对不对"必须与实际页面里的题号总数交叉核对，不能只看结果是否自洽。

# ── 页眉页脚噪声 ──
# 实测第 1 套最后一题（第 20 题）的题干末尾被塞进了：
#     "6 / 四海公考 / SIHAIGONGKAC / 练习题02"
# 那是页码 + 机构名 + 下一套的页眉。**只在"页边界恰好落在题末"时出现**，
# 所以它躲过了前面十几题的检查——这类噪声的特点就是位置相关、不是处处都有。
# 处理方式：分块时见到这些标记就**结束当前块**，而不是把它当题干的一部分。
RE_FOOTER_NOISE = [
    re.compile(r"^\s*四海公考\s*$"),
    re.compile(r"^\s*SIHAIGONGKAO\s*$", re.IGNORECASE),
    re.compile(r"^\s*练习题\s*\d{1,3}\s*$"),
    # 书名页眉。**形态不止一种**：片段阅读是"片段阅读600.(上册)"，
    # 逻辑判断是"逻辑判断600起"（OCR 把"篇"读成了"起"）。
    # 所以不能写死书名，要用"汉字+数字+可选字"的宽松形态。
    re.compile(r"^\s*片段阅读\s*600"),
    re.compile(r"^\s*逻辑判断\s*600"),
    re.compile(r"^\s*\d{1,3}\s*$"),  # 纯页码
]


def is_noise(line):
    """这一行是页眉页脚噪声吗？"""
    return any(p.match(line) for p in RE_FOOTER_NOISE)


def parse_set_headers(page_texts):
    """找出每一页出现的"练习题NN套"，得到 (页码, 套号)。

    这是对齐的锚：两个文件都印这个，且它是**排版无关**的。
    """
    found = []
    for page in sorted(page_texts):
        for m in RE_SET.finditer(page_texts[page]):
            found.append((page, int(m.group(1))))
    return found


def parse_question_blocks(page_texts):
    """把题本正文按「套号 + 套内题号」切成块。

    ═══ 为什么键必须带套号 ═══
    实测：题本【上】前 20 页切出 **60 个块**，题号序列是
        `1..20, 1..20, 1..20`
    也就是**三个"练习题套"，每套内部题号都从 1 重新开始**。

    我第一版只用题号做键，于是把第 2、3 套的同号题当成了"重复"丢掉，
    而丢掉之后剩下的那块未必属于第 1 套——
    结果是"报告里 Q4 的题干"和"诊断里 Q4 的题干"根本不是同一段文字。
    两个工具对同一份数据得出不同结论，就是从这里来的。

    **题号不是身份，"哪一套 + 套内第几题"才是。** 这与 ADR-017 决定 2 同源：
    顺序号不是身份——现在还要再补一句：**每套都重新开始的顺序号更不是身份。**

    套号从 `练习题NN套` 这个页眉读（实测每套开头都印）。若某套读不到页眉，
    则该块的 `set` 为 None，调用方应当标低置信度而不是猜。
    """
    blocks = []
    current = None
    current_set = None
    for page in sorted(page_texts):
        for ln in page_texts[page].split("\n"):
            sm = RE_SET.search(ln)
            if sm:
                current_set = int(sm.group(1))
                # 见到套头 = 上一题结束。不这么做的话，
                # 上一题会一直吃到下一套的开头（实测第 20 题就吃进了页脚与下一套页眉）。
                if current is not None:
                    blocks.append(current)
                    current = None
                continue
            if is_noise(ln):
                # ⚠ 噪声行要**跳过但延续当前块**，不要结束它。
                #
                # 我原来在这里写的是"结束当前块"（那是为片段阅读的题末污染修的），
                # 但**页眉可能出现在一道题的中间**。实测逻辑判断第 14 题：
                #
                #     …因此小兰是全公司最受欢迎的员工。
                #     4                      ← 页码
                #     逻辑判断600起            ← 书名页眉
                #     四海公考                ← 机构名
                #     下列选项最能削弱上述结论的是：   ← **题干的后半句**
                #     A. 公司的高层干部都没有参与…
                #
                # 块被切断后：`下列选项…` 与选项 A 被归给了**上一题**（污染），
                # 而第 14 题的 stem 只剩前半段、**选项全丢**。
                #
                # 为什么"跳过"是安全的：真正的边界由**题号行**给出
                # （`N.` 开头就会结束上一块），不需要靠噪声行来断。
                # 所以噪声行只需不作为内容收入即可。
                continue
            m = RE_QNUM.match(ln)
            if m and 1 <= int(m.group(1)) <= 200:
                if current is not None:
                    blocks.append(current)
                current = {
                    "set": current_set,
                    "no": int(m.group(1)),
                    "page": page,
                    "lines": [m.group(2)],
                    "raw": [ln],
                }
            elif current is not None:
                current["lines"].append(ln)
                current["raw"].append(ln)
    if current is not None:
        blocks.append(current)

    for b in blocks:
        b["text"] = "\n".join(b["lines"]).strip()
        opts = []
        for ln in b["lines"]:
            om = RE_OPTION.match(ln)
            if om:
                opts.append({"label": om.group(1).upper(), "text": om.group(2).strip()})
        b["options"] = opts
        stem_lines = [ln for ln in b["lines"] if not RE_OPTION.match(ln)]
        b["stem"] = "\n".join(stem_lines).strip()
        # 结构警告：选择题却拿不到选项，说明版面被某种噪声切断了。
        # 实测逻辑判断第 14 题就是这样：页眉落在题的中间，把 stem 的后半句与全部选项切走。
        # **不静默容忍**：标出来，让下游知道这道题的"低置信度"是有具体原因的。
        b["structural_warning"] = (
            "有题干但无选项（可能是页眉/页脚切断了题块）" if (not opts and len(b["stem"]) > 20) else None
        )
    return blocks


def dedupe_by_set_and_no(blocks):
    """按 (套号, 套内题号) 去重保序。

    同一套里同号出现两次，通常是**跨页重复**（页眉/页脚被识别成题号）或 OCR 噪声；
    这时保留**第一个**（正文先出现的那次）。
    """
    seen = set()
    out = []
    for b in blocks:
        key = (b.get("set"), b["no"])
        if key in seen:
            continue
        seen.add(key)
        out.append(b)
    return out


def parse_answer_blocks(page_texts):
    """把解析正文按题号切成块。

    解析页的题号前面有额外内容（如 `(2021年新疆省考 77%)`），批注还会插在中间。
    这里只负责切块；**不试图把批注从题干里摘干净**——
    因为按设计，题干只从题本取，解析只提供答案与讲解（见 docs/decisions 与对话记录）。
    """
    blocks = []
    current = None
    for page in sorted(page_texts):
        for ln in page_texts[page].split("\n"):
            m = RE_QNUM.match(ln)
            if m and 1 <= int(m.group(1)) <= 200:
                if current is not None:
                    blocks.append(current)
                current = {"no": int(m.group(1)), "page": page, "raw": [ln]}
            elif current is not None:
                current["raw"].append(ln)
    if current is not None:
        blocks.append(current)
    for b in blocks:
        b["text"] = "\n".join(b["raw"]).strip()
    return blocks


def verify_pair(qblock, ablock):
    """用题干文字验证配对。

    判据：题本题干的前 12 个非标点字符，应当出现在解析块里。
    取 12 个字符是折中——太少会在题库里撞车（"这段文字旨在说明"这种套话），
    太多则会被 OCR 错字打断。
    """
    qn = normalize(qblock["stem"])[:12]
    an = normalize(ablock.get("text", ""))
    if len(qn) < 6:
        return {"ok": None, "reason": f"题干太短，无法验证（{qn!r}）"}
    hit = qn in an
    return {
        "ok": hit,
        "probe": qn,
        "reason": "题干文字出现在解析块里" if hit else "题干文字**没有**出现在解析块里",
    }


def cmd_plan(args):
    """为一套题生成"要 OCR 哪些页"的计划。

    按**题目数量**而不是页数决定读到哪——这正是作者纠正的点。
    """
    doc_q = pymupdf.open(args.question_pdf)
    doc_a = pymupdf.open(args.answer_pdf)

    # 目录页告诉我们这套题的套号范围（第 1 页，实测）
    plan = {
        "set": args.set,
        "questions_wanted": args.questions,
        "question_pdf": os.path.abspath(args.question_pdf),
        "answer_pdf": os.path.abspath(args.answer_pdf),
        "question_pages": None,
        "answer_pages": None,
        "note": (
            "页数由后续 OCR 迭代决定：先读一批，数够 N 题就停。"
            "这里给出保守的起始量（按题本约 15 题/页、解析约 6 题/页估）。"
        ),
    }
    q_pages = doc_q.page_count
    a_pages = doc_a.page_count
    plan["question_page_count"] = q_pages
    plan["answer_page_count"] = a_pages
    plan["question_start_pages"] = f"1-{min(q_pages, max(4, args.questions // 12 + 4))}"
    plan["answer_start_pages"] = f"1-{min(a_pages, max(6, args.questions // 5 + 5))}"

    doc_q.close()
    doc_a.close()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(os.path.join(args.out, "plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan, fh, ensure_ascii=False, indent=2)
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    return 0


def locate_by_stem(stem, full_text, min_chars=8, max_edits=4):
    """在解析全文里按**题干文字**定位这道题的讲解起点。

    ═══ 为什么不切解析的块，而去定位题干 ═══
    第一版对解析也做"按行首数字切块"，实测失败：
        题本第 6 题 → 解析第 18 题（错位）
    根因是解析页里的**来源标注也以数字开头**（`1. (2021 年新疆省考 77%)`），
    被切块正则当成了题号。

    ═══ 为什么也不能用"连续子串"匹配 ═══
    第二版改成"题干前 N 字在解析里连续出现就算定位到"，仍然失败 2 题。
    诊断（scripts/diagnose_stem_break.py）把两边并排打出来，真相是：

        题本: …具有无可替代的积极作用 它能集中人力物力财力能
        解析: …具有无可替代的积极作用 它能⑧花生批注 集中人…

        题本: …的确是 无论是学习还是成长 都是逐渐拔节的过程
        解析: …的确是 无论是学习还是成长 [行文结构][后观点结构][开篇引出话题]…

    **解析把批注与讲解插进了题干句子的中间**——题干文字被切开了。
    所以连续子串匹配在解析上**原理上就会失败**，不是阈值没调好。

    ═══ 现在的做法：容忍少量编辑距离的模糊定位 ═══
    用 `difflib` 在滑动窗口里找"与题干前缀最像"的位置，允许少量插入/替换
    （批注插入字符、OCR 错字都会表现为少量编辑）。
    阈值定在 0.72 相似度：实测能容忍批注插入，又不会把邻近的别题误认成这一题。

    ⚠ 关键：模糊匹配**天然会有误配**，所以调用方必须做两件事——
    ① 强制位置单调（第 N 题的匹配位置必须大于第 N-1 题）；
    ② 把相似度报出来，低相似度的题标出来让人/LLM 复核（ADR-020 决定 5）。
    """
    import difflib

    probe = normalize(stem)[: min_chars + 24]
    short = normalize(stem)[:min_chars]
    if len(short) < 6:
        return {"ok": False, "reason": f"题干太短，无法定位（{short!r}）", "probe": short}

    flat = normalize(full_text)
    mapping = [i for i, ch in enumerate(full_text) if ch not in PUNCT and not ch.isspace()]

    # 快路径：短前缀连续出现且唯一 → 直接用
    if flat.count(short) == 1:
        pos = flat.find(short)
        return {"ok": True, "probe": short, "start": mapping[pos], "similarity": 1.0, "method": "exact"}

    # 慢路径：滑动窗口 + **子序列**相似度
    #
    # ═══ 为什么用子序列而不是 difflib 的等长相似度 ═══
    # 第一版把窗口长度设成"探针长度"，用 difflib.SequenceMatcher 比等长片段。
    # 实测失败（Q11 只有 0.58）：因为批注**插在题干中间**，
    # 插入的文字把后面的题干内容**挤出了窗口**，于是相似度被拉低——
    # 窗口定成探针等长本身就是错的，插入越多越不可能命中。
    #
    # 子序列（subsequence）匹配对插入天然鲁棒：它只要求探针的字符**按顺序出现**，
    # 中间夹多少别的东西都不影响。这正是"批注插在句子里"这个真实情形的正确模型。
    #
    # ⚠ 子序列的代价是**误配风险更高**（顺序对但位置不对）。
    # 所以阈值要高（0.86），并且外层必须做单调性检查与低相似度上报。
    probe_chars = list(probe)
    win = min(len(flat), len(probe) * 6 + 120)
    best_ratio = 0.0
    best_pos = -1
    step = max(1, len(probe) // 2)
    for pos in range(0, max(1, len(flat) - win + 1), step):
        window = flat[pos:pos + win]
        # 贪心求探针在窗口里的最长子序列命中数
        i = 0
        for ch in window:
            if i < len(probe_chars) and ch == probe_chars[i]:
                i += 1
        ratio = i / len(probe_chars)
        if ratio > best_ratio:
            best_ratio, best_pos = ratio, pos

    if best_ratio >= 0.86 and best_pos >= 0:
        return {
            "ok": True,
            "probe": short,
            "start": mapping[best_pos],
            "similarity": round(best_ratio, 3),
            "method": "subsequence",
        }
    return {
        "ok": False,
        "reason": f"最相似的位置只命中 {best_ratio:.2f} 的探针字符（阈值 0.86）",
        "probe": short,
        "best_ratio": round(best_ratio, 3),
    }


def cmd_match(args):
    """按题目顺序对齐并逐题校验。"""
    pages = load_pages(args.ocr)
    if not pages:
        print("没有读到 OCR 结果")
        return 2

    q_key = a_key = None
    for k in pages:
        base = os.path.basename(k)
        if "题本" in base:
            q_key = k
        elif "解析" in base:
            a_key = k
    if q_key is None or a_key is None:
        print(f"没法区分题本与解析。读到的文件：{[os.path.basename(k) for k in pages]}")
        return 2

    q_texts = {p: pl.get("text", "") for p, pl in pages[q_key].items()}
    a_texts = {p: pl.get("text", "") for p, pl in pages[a_key].items()}

    # 题本：按 (套号, 套内题号) 切块与去重
    q_blocks = parse_question_blocks(q_texts)
    q_seq = dedupe_by_set_and_no(q_blocks)

    # 解析：不切块，整篇拼成一条文本，靠题干定位
    a_full = "\n".join(a_texts[p] for p in sorted(a_texts))

    # 定位每一题
    located = []
    for b in q_seq:
        loc = locate_by_stem(b["stem"], a_full, min_chars=args.probe_chars)
        located.append((b, loc))

    # 截断：第 i 题的讲解 = [第 i 题起点, 第 i+1 题起点)
    for i, (b, loc) in enumerate(located):
        if not loc.get("ok"):
            b["answer_span"] = None
            continue
        nxt = None
        for j in range(i + 1, len(located)):
            if located[j][1].get("ok"):
                nxt = located[j][1]["start"]
                break
        b["answer_span"] = [loc["start"], nxt if nxt is not None else len(a_full)]
        b["answer_text"] = a_full[loc["start"]: b["answer_span"][1]]

    n = min(len(located), args.limit or 10**9)
    results = []
    ok = bad = 0
    low_similarity = []
    order_ok = True
    prev_start = -1
    for i in range(n):
        qb, loc = located[i]
        verified = loc.get("ok", False)
        if verified:
            ok += 1
            # 单调性检查：题干在解析里的出现位置必须递增。
            # 这一条能抓住"两题定位到同一处"或"顺序颠倒"的错位。
            if loc["start"] < prev_start:
                order_ok = False
                verified = False
            prev_start = loc["start"]
            # 低相似度 = 模糊匹配勉强命中，最可能是误配——
            # 这些正是 ADR-020 决定 5 要交给 LLM 复核的题
            sim = loc.get("similarity")
            if isinstance(sim, (int, float)) and sim < 0.85:
                low_similarity.append({"index": i + 1, "set": qb.get("set"), "no": qb["no"], "similarity": sim})
        else:
            bad += 1
        results.append(
            {
                "index": i + 1,
                "set": qb.get("set"),
                "question_no": qb["no"],
                "question_page": qb["page"],
                # 注意用 verified（已被单调性校正的结果），不是 loc.get("ok")——
                # 直接报 loc 的话，"位置倒退"的题会显示成成功，那是自欺。
                "located": verified,
                "located_at": loc.get("start"),
                "similarity": loc.get("similarity"),
                "method": loc.get("method"),
                "reason": loc.get("reason", "题干文字在解析全文里定位到"),
                "probe": loc.get("probe"),
                "stem_head": qb["stem"][:50],
                # 全文也存下来：报告是这一阶段的主要产物，
                # 只留 50 字的话，人无法据它判断"这题分对了没有"
                "stem_full": qb["stem"],
                "options": qb["options"],
                "answer_text_head": (qb.get("answer_text") or "")[:120],
                "answer_text_full": qb.get("answer_text") or "",
            }
        )

    report = {
        "question_file": os.path.basename(q_key),
        "answer_file": os.path.basename(a_key),
        "probe_chars": args.probe_chars,
        "question_pages_used": sorted(q_texts),
        "answer_pages_used": sorted(a_texts),
        "question_blocks": len(q_seq),
        "compared": n,
        "verified_ok": ok,
        "verified_bad": bad,
        "monotonic": order_ok,
        "low_similarity": low_similarity,
        "verdict": "ALIGNED" if (bad == 0 and ok > 0 and order_ok) else "MISALIGNED" if bad > 0 or not order_ok else "INCONCLUSIVE",
        "results": results,
    }

    out = args.out or "data/align-report.json"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    print(f"question blocks={len(q_seq)}  compared={n}")
    print(f"located ok={ok}  failed={bad}  monotonic={order_ok}  verdict={report['verdict']}")
    if low_similarity:
        print(f"low-similarity (need LLM spot-check): {len(low_similarity)} -> {[x['similarity'] for x in low_similarity]}")
    print(f"JSON: {out}")
    print("\nstdout is ASCII-only; open the JSON for the per-question detail.")
    return 0 if bad == 0 and order_ok else 1


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("plan")
    p1.add_argument("--question-pdf", required=True)
    p1.add_argument("--answer-pdf", required=True)
    p1.add_argument("--set", type=int, default=1)
    p1.add_argument("--questions", type=int, default=20)
    p1.add_argument("--out", required=True)
    p1.set_defaults(func=cmd_plan)

    p2 = sub.add_parser("match")
    p2.add_argument("--plan")
    p2.add_argument("--ocr", nargs="*", required=True)
    p2.add_argument("--limit", type=int, default=0)
    p2.add_argument("--probe-chars", type=int, default=12, help="用题干前几个非标点字符去解析里定位")
    p2.add_argument("--out")
    p2.set_defaults(func=cmd_match)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
