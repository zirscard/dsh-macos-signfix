/**
 * dsh-macos-signfix · runner.
 *
 * Orchestrates diagnose / sign / verify / auto for a Python interpreter.
 *
 * @module dsh-macos-signfix/runner
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { diagnose } from './core/diagnose.js'
import { sign } from './core/sign.js'
import { verify } from './core/verify.js'

function dshHome() {
  const override = process.env.DSH_HOME
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh')
}

/** Default interpreter: DSH primary-runtime python3. */
export function resolvePython(explicit) {
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit
  if (process.env.DSH_PYTHON && process.env.DSH_PYTHON.length > 0) return process.env.DSH_PYTHON
  const runtime = join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python')
  const candidates = [
    join(runtime, 'bin', 'python3'),
    join(runtime, 'bin', 'python'),
    join(runtime, 'python.exe'),
    join(runtime, 'bin', 'python.exe'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return 'python3'
}

/**
 * @param {object} options
 * @param {string} [options.pythonPath] - interpreter to fix (default: DSH built-in)
 * @param {'diagnose'|'sign'|'verify'|'auto'} [options.mode] - default 'auto'
 * @param {boolean} [options.force] - re-sign even if already fixed
 * @param {boolean} [options.deep] - deep verify (RapidOCR inference)
 * @param {boolean} [options.resignExtensions] - also re-sign native extensions
 * @param {string} options.engineRoot - plugin root
 */
export async function runSignFix(options) {
  const pluginRoot = options.engineRoot
  const pythonPath = resolvePython(options.pythonPath)
  const mode = options.mode ?? 'auto'

  if (!existsSync(pythonPath)) {
    return { ok: false, error: `interpreter not found: ${pythonPath}` }
  }

  if (mode === 'diagnose') {
    return { ok: true, mode, ...(await diagnose({ pythonPath })) }
  }

  if (mode === 'verify') {
    const v = await verify({ pythonPath, deep: options.deep === true })
    return { ok: v.ok, mode, pythonPath, verify: v }
  }

  if (mode === 'sign') {
    const s = await sign({ pythonPath, pluginRoot, force: options.force === true, resignExtensions: options.resignExtensions === true })
    return { ok: s.ok, mode, pythonPath, sign: s }
  }

  // auto: diagnose → sign if needed → verify
  const d0 = await diagnose({ pythonPath })
  if (!d0.needsFix) {
    const v = await verify({ pythonPath, deep: options.deep === true })
    return { ok: v.ok, mode, pythonPath, action: 'noop', diagnose: d0, verify: v }
  }
  const s = await sign({ pythonPath, pluginRoot, force: options.force === true, resignExtensions: options.resignExtensions === true })
  const v = await verify({ pythonPath, deep: options.deep === true })
  return { ok: s.ok && v.ok, mode, pythonPath, action: 'signed', diagnose: d0, sign: s, verify: v }
}
