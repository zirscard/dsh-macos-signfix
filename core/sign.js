/**
 * dsh-macos-signfix · sign.
 *
 * Plan A: re-sign the Python interpreter ad-hoc with `--options runtime` plus
 * the `disable-library-validation` entitlement, and (optionally) re-sign the
 * native extension bundles ad-hoc without `--options runtime`.
 *
 * Why this works: the DSH interpreter carries hardened runtime (`flags=...runtime`)
 * and a Developer ID Team ID; Library Validation then only accepts libraries with
 * the same Team ID, while pip wheels are ad-hoc (no Team ID). The
 * `com.apple.security.cs.disable-library-validation` entitlement tells the runtime
 * to skip that check.
 *
 * Idempotent: if the interpreter already carries the entitlement and imports work,
 * `sign` is a no-op unless `force` is true. Always backs up the original binary
 * and its codesign dump to sign/backup/<timestamp>/ before touching it.
 *
 * Safety: never signs the enclosing Electron .app, never uses --deep on the app.
 *
 * @module dsh-macos-signfix/core/sign
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { exec } from './proc.js'
import { readSignature, probeImports } from './diagnose.js'

const KEY_ENTITLEMENT = 'com.apple.security.cs.disable-library-validation'

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function backupDir(pluginRoot) {
  return join(pluginRoot, 'sign', 'backup')
}

/**
 * Back up the interpreter binary (with its original embedded signature) and its
 * codesign dump. Returns the backup directory path.
 */
export function backupInterpreter({ pythonPath, pluginRoot }) {
  const dir = join(backupDir(pluginRoot), timestamp())
  mkdirSync(dir, { recursive: true })
  const binCopy = join(dir, `${require_basename(pythonPath)}.orig`)
  copyFileSync(pythonPath, binCopy)
  return { dir, binCopy }
}

// tiny helper so this module needs no extra import just for basename
function require_basename(p) {
  return String(p).split('/').pop()
}

/**
 * Re-sign one Mach-O target ad-hoc. `runtime` controls --options runtime.
 */
async function resign(target, { entitlementsPath, runtime }) {
  const args = ['--force']
  if (runtime) args.push('--options', 'runtime')
  if (entitlementsPath) args.push('--entitlements', entitlementsPath)
  args.push('--sign', '-', target)
  return exec('codesign', args)
}

/**
 * Read the interpreter's site-packages dir from the interpreter itself
 * (works across Python versions and layouts).
 */
export async function findSitePackages(pythonPath) {
  const r = await exec(pythonPath, ['-c', "import sysconfig; print(sysconfig.get_paths()['purelib'])"])
  const p = (r.stdout || '').trim().split('\n').pop()
  return r.code === 0 && p ? p : undefined
}

/**
 * Plan A execute.
 *
 * @param {object} opts
 * @param {string} opts.pythonPath
 * @param {string} opts.pluginRoot - dsh-macos-signfix root (holds sign/entitlements)
 * @param {boolean} [opts.force] - re-sign even if already fixed
 * @param {boolean} [opts.resignExtensions] - also re-sign native extensions (A3)
 * @returns {Promise<object>} before/after record
 */
export async function sign({ pythonPath, pluginRoot, force = false, resignExtensions = false }) {
  const entitlementsPath = join(pluginRoot, 'sign', 'disable-library-validation.entitlements')
  if (!existsSync(entitlementsPath)) {
    return { ok: false, error: `entitlements file missing: ${entitlementsPath}` }
  }

  const before = await readSignature(pythonPath)
  const probeBefore = await probeImports(pythonPath)

  // Idempotency: already fixed → no-op unless force.
  if (!force && probeBefore.ok && before.hasDisableLibraryValidation) {
    return {
      ok: true,
      changed: false,
      reason: 'already_fixed',
      pythonPath,
      before: summarize(before, probeBefore),
      after: summarize(before, probeBefore),
    }
  }

  // Backup first (binary + codesign dump).
  const { dir: backupDirPath, binCopy } = backupInterpreter({ pythonPath, pluginRoot })
  writeFileSync(join(backupDirPath, 'codesign-before.txt'), before.raw, 'utf8')
  writeFileSync(join(backupDirPath, 'meta.json'), JSON.stringify({
    pythonPath,
    backedUpAt: new Date().toISOString(),
    binary: binCopy,
    beforeFlags: before.flags,
    beforeTeam: before.teamIdentifier,
  }, null, 1), 'utf8')

  // A2: re-sign the interpreter with runtime + entitlement.
  const r = await resign(pythonPath, { entitlementsPath, runtime: true })
  if (r.code !== 0) {
    return {
      ok: false,
      changed: false,
      error: `codesign interpreter failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-400)}`,
      backupDir: backupDirPath,
      before: summarize(before, probeBefore),
    }
  }

  // A3 (optional): re-sign native extensions ad-hoc WITHOUT runtime.
  let extensionResult = null
  if (resignExtensions) {
    const site = await findSitePackages(pythonPath)
    if (site && existsSync(site)) {
      extensionResult = await resignExtensionsAdhoc({ sitePackages: site, pythonPath })
    } else {
      extensionResult = { ok: false, error: `site-packages not found (${site ?? 'undefined'})` }
    }
  }

  const after = await readSignature(pythonPath)
  const probeAfter = await probeImports(pythonPath)

  return {
    ok: probeAfter.ok,
    changed: true,
    pythonPath,
    entitlements: entitlementsPath,
    backupDir: backupDirPath,
    before: summarize(before, probeBefore),
    after: summarize(after, probeAfter),
    extensions: extensionResult,
    note: probeAfter.ok
      ? 'fixed: interpreter loads onnxruntime/cv2/pypdfium2'
      : 're-signed but imports still fail; see after.errors',
  }
}

function summarize(sig, probe) {
  return {
    signed: sig.signed,
    adhoc: sig.adhoc,
    runtime: sig.runtime,
    teamIdentifier: sig.teamIdentifier,
    flags: sig.flags,
    entitlements: sig.entitlements,
    hasDisableLibraryValidation: sig.hasDisableLibraryValidation,
    importsOk: probe.ok,
    importErrors: probe.errors,
  }
}

/**
 * A3: re-sign the native extension bundles ad-hoc (no runtime). Optional because
 * the interpreter entitlement alone fixes loading; kept for stubborn cases.
 */
async function resignExtensionsAdhoc({ sitePackages }) {
  // find onnxruntime / cv2 / pypdfium2 native files
  const find = await exec('find', [
    sitePackages,
    '-type', 'f',
    '(', '-name', '*.so', '-o', '-name', '*.dylib', ')',
    '(', '-path', '*onnxruntime*', '-o', '-path', '*cv2*', '-o', '-path', '*pypdfium2*', ')',
    '-print',
  ])
  const files = (find.stdout || '').split('\n').filter(Boolean)
  let signed = 0
  const errors = []
  for (const f of files) {
    const r = await resign(f, { runtime: false })
    if (r.code === 0) signed += 1
    else errors.push(`${f}: ${(r.stderr || r.stdout).trim().slice(0, 120)}`)
  }
  return { ok: errors.length === 0, total: files.length, signed, errors: errors.slice(0, 10) }
}
