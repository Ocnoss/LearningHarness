"""看每题的三项印证信号，核对置信度是怎么算出来的。

═══ 为什么要单独看这个 ═══
改了置信度算法之后，分布从 `high:7 medium:12` 变成 `high:3 medium:17`。
分布变化必须能解释——有可能是我放宽了标准（把可疑的也算进去了），
那会让"置信度"这个字段失去意义，而它的全部价值就在于**能筛出要复核的题**。
所以把每题的原始信号摊开，人不看算法只看事实。
"""

import argparse
import json
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extracted", required=True)
    args = ap.parse_args()

    with open(args.extracted, encoding="utf-8") as fh:
        data = json.load(fh)

    print(f"total={data['total']}  dist={data['confidence_dist']}")
    print("")
    print("q    ans  conf    在选项内 讲解提及 分布法  选中项评注        其他项评注数  讲解占位")
    print("-" * 96)
    for e in data["items"]:
        ans = (e.get("answer") or ["-"])[0]
        notes = e.get("option_notes") or {}
        others = sum(1 for k, v in notes.items() if k != ans and v)
        chosen_note = notes.get(ans, "")
        print(
            f"{e['no']:<4} {ans:<4} {e.get('confidence', '-'):<8} "
            f"{str(e.get('answer_in_options')):<8} "
            f"{str(e.get('explanation_mentions_answer')):<8} "
            f"{str(e.get('other_option_notes_ok')):<6} "
            f"{('「' + chosen_note + '」') if chosen_note else '(空)':<18} "
            f"{others:<13} "
            f"{e.get('analysis_is_placeholder')}"
        )

    print("")
    print("=== 按置信度分组 ===")
    for level in ("high", "medium", "low", "none"):
        group = [e for e in data["items"] if e.get("confidence") == level]
        if not group:
            continue
        print(f"\n{level} ({len(group)} 题):")
        for e in group:
            notes = e.get("option_notes") or {}
            ans = (e.get("answer") or ["-"])[0]
            others = {k: v for k, v in notes.items() if k != ans and v}
            print(f"  q{e['no']:<3} ans={ans}  其他项评注={others}  "
                  f"讲解提及={e.get('explanation_mentions_answer')}  在选项内={e.get('answer_in_options')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
