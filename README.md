# dsh-macos-signfix · macOS 代码签名修复插件

修复 **DSH 内置 Python 在 macOS Hardened Runtime 下拒绝加载原生扩展**（onnxruntime / cv2 / pypdfium2）的问题。agent 工具 **`doc_ocr_sign_fix`** 提供 diagnose / sign / verify / auto 四种模式。

## 一、根因（一句话）

> **DSH Desktop 的内置 python 是 Developer ID 签名（Team `NAN929V4UM`）并启用 Hardened Runtime（`flags=0x10000(runtime)`）；Hardened Runtime 启用 Library Validation，只接受与进程同 Team ID 的动态库；pip wheel 里的 `.so/.dylib` 是 ad-hoc（无 Team ID），dyld 因此拒绝加载。**

不是 Gatekeeper / quarantine 问题，`xattr -cr` 不解决。

实际报错（`dsh-ocr/test/macos-sign-report.txt` 有完整记录）：

```text
ImportError: dlopen(.../onnxruntime/capi/onnxruntime_pybind11_state.so, 0x0002):
  ... not valid for use in process:
  mapping process and mapped file (non-platform) have different Team IDs
```

## 二、修复（方案 A）

对解释器注入 `com.apple.security.cs.disable-library-validation` entitlement 并 ad-hoc 重签：

```bash
codesign --force --options runtime \
  --entitlements sign/disable-library-validation.entitlements \
  --sign - ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
```

- `--options runtime` 保留 Hardened Runtime（不破坏运行时语义），通过 entitlement 关闭 Library Validation；
- 原二进制与 `codesign -dvvv` 输出备份到 `sign/backup/<timestamp>/`；
- 幂等：已修复且 import 正常时 `sign`/`auto` 为 no-op；
- **不碰 Electron 外层 App**（绝不 `--deep` 签 `.app`）。

## 三、工具：`doc_ocr_sign_fix`

| 参数 | 说明 |
|---|---|
| `pythonPath` | 要修复的解释器；默认 DSH 内置 `primary-runtime/bin/python3` |
| `mode` | `diagnose` / `sign` / `verify` / `auto`（默认） |
| `force` | 已修复也强制重签（默认 false，幂等） |
| `deep` | verify 时额外实例化 RapidOCR 跑一次最小推理 |
| `resignExtensions` | 额外对 onnxruntime/cv2/pypdfium2 的 `.so/.dylib` 做 ad-hoc 重签（通常不需要，解释器 entitlement 已足够） |

- `diagnose` → `{ signed, adhoc, runtime, teamIdentifier, entitlements, imports.ok, imports.errors, needsFix, verdict }`
- `sign` → 前后签名状态 + `backupDir` + `changed`
- `verify` → shallow（import + 版本）/ deep（RapidOCR 推理）
- `auto` → diagnose → 需要则 sign → verify

## 四、安装与自检

```bash
dsh plugin --profile desktop add link:<plugin-dir>/dsh-macos-signfix
```

自检（复用内置 python，跑诊断→签名幂等→import→doc_ocr 回归）：

```bash
DSH_PY=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
"$DSH_PY" <plugin-dir>/dsh-macos-signfix/test/run_tests.py
```

## 五、验收命令

```bash
DSH_PY=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
codesign -dvvv --entitlements - "$DSH_PY" | grep disable-library   # 有 → OK
"$DSH_PY" -c "import onnxruntime, cv2, pypdfium2; print('OK')"       # 退出码 0
```

## 六、红线

- 不对 `/Applications/DeepSeek Harness.app` 本身 `codesign --deep --force --sign -`（破坏 Electron 外层签名 → App 崩溃）；
- 不依赖 `DYLD_LIBRARY_PATH`（Hardened Runtime 下 Python 会忽略）；
- Anaconda 只作为 `auto` 失败时的降级，不是最终方案；`doc_ocr` 会标注 `fallback_used`。

## 七、升级后注意事项

每次 DSH Desktop 升级/重装运行时，内置 python 可能恢复原签名 → 重跑一次 `doc_ocr_sign_fix(mode="auto")` 即可；`doc_ocr` 的 `runner.js` 在修复失效时会自动降级到 Anaconda，不阻塞 OCR。
