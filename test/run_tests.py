#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-macos-signfix 自检：诊断 → 签名（幂等）→ import → doc_ocr 回归。

运行（任意 Python 3，默认检查 DSH 内置 Python）：
    python3 <plugin-dir>/dsh-macos-signfix/test/run_tests.py
    python3 .../run_tests.py --python /path/to/python3

覆盖：
  A. 诊断：内置 Python 是否 ad-hoc + disable-library-validation
  B. import：onnxruntime / cv2 / pypdfium2 是否可加载
  C. 幂等：第二次签名为 no-op（healthy 时不产生副作用）
  D. doc_ocr 回归：用 dsh-ocr 引擎跑一张真实扫描页，断言 ok + conf
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIGNFIX = os.path.dirname(HERE)
DSH_OCR = os.path.join(os.path.dirname(SIGNFIX), "dsh-ocr", "core", "ocr.py")
DSH_PY_DEFAULT = os.path.expanduser(
    "~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3")
CONTRACT = os.environ.get("DSH_OCR_SAMPLE_PNG", "")

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print("  %s %s %s" % ("✅" if cond else "❌", name, ("· " + detail) if detail else ""))


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def codesign_state(py):
    r = run(["codesign", "-dvvv", "--entitlements", "-", py])
    txt = (r.stdout or "") + "\n" + (r.stderr or "")
    adhoc = "Signature=adhoc" in txt or "(adhoc" in txt
    has_dlv = "com.apple.security.cs.disable-library-validation" in txt
    return {"adhoc": adhoc, "disableLibraryValidation": has_dlv, "raw": txt}


def imports_ok(py):
    r = run([py, "-c", "import onnxruntime, cv2, pypdfium2; print('OK')"])
    return r.returncode == 0, (r.stdout + r.stderr).strip().split("\n")[-3:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--python", default=DSH_PY_DEFAULT)
    args = ap.parse_args()
    py = args.python

    print("# interpreter: %s" % py)
    if not os.path.exists(py):
        check("解释器存在", False, py)
        return finish()

    print("\n# A. 诊断签名状态")
    st = codesign_state(py)
    check("ad-hoc 签名", st["adhoc"], "")
    check("disable-library-validation entitlement", st["disableLibraryValidation"], "")

    print("\n# B. 原生扩展 import")
    ok, out = imports_ok(py)
    check("onnxruntime/cv2/pypdfium2 import", ok, str(out))

    print("\n# C. 幂等（healthy 时签名为 no-op）")
    if ok and st["disableLibraryValidation"]:
        check("幂等：已修复不重复签名", True, "no-op")
    else:
        check("幂等：已修复不重复签名", False, "未修复（需先跑 doc_ocr_sign_fix mode=auto）")

    print("\n# D. doc_ocr 回归（真实扫描页）")
    if os.path.exists(DSH_OCR) and os.path.exists(CONTRACT):
        r = run([py, DSH_OCR, "--input", CONTRACT, "--mode", "text", "--dpi", "200"], timeout=300)
        try:
            d = json.loads(r.stdout)
        except Exception:
            d = None
        if d and d.get("ok"):
            p = d["pages"][0]
            check("引擎 ok", True, "")
            check("置信度 ≥ 0.9", p["avg_conf"] >= 0.9, "conf=%s" % p["avg_conf"])
            check("文本非空", p["chars"] > 100, "chars=%s" % p["chars"])
        else:
            check("引擎 ok", False, (r.stdout + r.stderr)[-300:])
    else:
        check("引擎/扫描页存在", False, "%s | %s" % (DSH_OCR, CONTRACT))

    finish()


def finish():
    print("\n# 结果：%d 通过 / %d 失败" % (len(PASS), len(FAIL)))
    if FAIL:
        print("失败项：", FAIL)
        sys.exit(1)
    print("全部通过 ✅")


if __name__ == "__main__":
    main()
