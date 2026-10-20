/**
 * dsh-macos-signfix · diagnose.
 *
 * Reads the exact signing state of a Python interpreter and of the native
 * extensions it is asked to load, then classifies the failure.
 *
 * Failure signatures this recognizes:
 *   - "different Team IDs"                 → hardened runtime + library validation
 *   - "code signature ... not valid"       → library validation
 *   - "library load disallowed by system policy"
 *   - "no suitable image found ... not validly signed"
 *
 * @module dsh-macos-signfix/core/diagnose
 */
import { exec } from './proc.js'

const KEY_ENTITLEMENT = 'com.apple.security.cs.disable-library-validation'

/** Parse `codesign -dvvv --entitlements - <path>` into a small record. */
export async function readSignature(target) {
  const r = await exec('codesign', ['-dvvv', '--entitlements', '-', target])
  // codesign writes the details to stderr; both streams are searched defensively.
  const text = `${r.stdout}\n${r.stderr}`
  const flagsMatch = text.match(/flags=0x([0-9a-fA-F]+)\(([^)]*)\)/)
  const team = text.match(/TeamIdentifier=([^\n]+)/)
  const authorities = [...text.matchAll(/Authority=([^\n]+)/g)].map((m) => m[1].trim())
  const entitlements = []
  // entitlements plist: keys appear as `[Key] com.apple...` in `--entitlements -` output
  for (const m of text.matchAll(/\[Key\]\s+([^\n]+)/g)) entitlements.push(m[1].trim())
  const adhoc = /Signature=adhoc/.test(text) || /flags=0x[0-9a-fA-F]+\([^)]*adhoc[^)]*\)/.test(text)
  const runtime = /(^|[\s,(])runtime([\s,)]|$)/.test(flagsMatch?.[2] ?? '')
  const signed = authorities.length > 0 || adhoc
  return {
    target,
    signed,
    adhoc,
    runtime,
    teamIdentifier: team ? team[1].trim() : 'not set',
    authorities,
    flags: flagsMatch ? `0x${flagsMatch[1]}(${flagsMatch[2]})` : null,
    entitlements,
    hasDisableLibraryValidation: entitlements.includes(KEY_ENTITLEMENT),
    raw: text,
  }
}

/** Try importing the native extensions with the given interpreter. */
export async function probeImports(pythonPath, modules = ['onnxruntime', 'cv2', 'pypdfium2']) {
  const code = modules.map((m) => `import ${m}`).join('; ') + `; print('OK')`
  const r = await exec(pythonPath, ['-c', code])
  const combined = `${r.stdout}\n${r.stderr}`
  return {
    ok: r.code === 0,
    code: r.code,
    modules,
    errors: r.code === 0 ? [] : classifyDyldError(combined),
    raw: combined,
  }
}

/** Turn raw dyld/python errors into a short failure kind. */
export function classifyDyldError(text) {
  const errors = []
  if (/different Team IDs/.test(text)) errors.push('library_validation_team_id_mismatch')
  if (/code signature[^\n]*not valid|not valid for use in process/.test(text)) errors.push('invalid_code_signature')
  if (/library load disallowed by system policy/.test(text)) errors.push('library_load_disallowed_by_policy')
  if (/no suitable image found|not validly signed/.test(text)) errors.push('not_validly_signed')
  if (/ModuleNotFoundError/.test(text)) errors.push('module_not_installed')
  if (errors.length === 0) errors.push('unknown_import_error')
  return [...new Set(errors)]
}

/**
 * Full diagnose: signature state of interpreter + import probe.
 * `needsFix` is true when imports fail and the interpreter does not already
 * carry disable-library-validation.
 */
export async function diagnose({ pythonPath }) {
  const sig = await readSignature(pythonPath)
  const probe = await probeImports(pythonPath)
  const needsFix = !probe.ok && !sig.hasDisableLibraryValidation
  const verdict = probe.ok
    ? 'healthy'
    : needsFix
      ? 'needs_signfix'
      : 'fixed_but_still_failing'
  return {
    ok: true,
    verdict,
    pythonPath,
    signature: {
      signed: sig.signed,
      adhoc: sig.adhoc,
      runtime: sig.runtime,
      teamIdentifier: sig.teamIdentifier,
      flags: sig.flags,
      entitlements: sig.entitlements,
      hasDisableLibraryValidation: sig.hasDisableLibraryValidation,
    },
    imports: {
      ok: probe.ok,
      modules: probe.modules,
      errors: probe.errors,
    },
    needsFix,
  }
}
