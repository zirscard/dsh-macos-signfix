/**
 * dsh-macos-signfix · verify.
 *
 * Two levels:
 *   - shallow (default): `import onnxruntime, cv2, pypdfium2` + versions.
 *   - deep: instantiate RapidOCR and run one tiny inference, proving the whole
 *     OCR pipeline (detection + recognition ONNX models) actually executes.
 *
 * @module dsh-macos-signfix/core/verify
 */
import { exec } from './proc.js'

export async function verify({ pythonPath, deep = false }) {
  const shallow = await exec(pythonPath, ['-c', [
    'import onnxruntime, cv2, pypdfium2',
    "print('onnxruntime', onnxruntime.__version__)",
    "print('cv2', cv2.__version__)",
    "print('pypdfium2', getattr(pypdfium2, '__version__', '?'))",
  ].join('; ')])
  const shallowOk = shallow.code === 0

  let deepResult = null
  if (shallowOk && deep) {
    deepResult = await runDeepInference(pythonPath)
  }

  return {
    ok: shallowOk && (deepResult === null || deepResult.ok),
    pythonPath,
    shallow: {
      ok: shallowOk,
      exitCode: shallow.code,
      output: (shallow.stdout || shallow.stderr).trim().split('\n').slice(-6),
    },
    deep: deepResult,
  }
}

/**
 * Instantiate RapidOCR and OCR a tiny generated image.
 * The image is a white canvas with a black bar so the detector has something to
 * find; we only care that the pipeline runs without raising.
 */
async function runDeepInference(pythonPath) {
  const py = [
    'import io, sys',
    'from PIL import Image, ImageDraw',
    'img = Image.new("RGB", (240, 80), "white")',
    'd = ImageDraw.Draw(img)',
    'd.rectangle([20, 25, 220, 60], fill="black")',
    'from rapidocr_onnxruntime import RapidOCR',
    'engine = RapidOCR()',
    'res, _ = engine(img)',
    "print('inference_ok', 'lines=%s' % (0 if res is None else len(res)))",
  ].join('\n')
  const r = await exec(pythonPath, ['-c', py], { timeoutMs: 300_000 })
  return {
    ok: r.code === 0,
    exitCode: r.code,
    output: (r.stdout || r.stderr).trim().split('\n').slice(-4),
  }
}
