/**
 * Host half of dsh-macos-signfix.
 *
 * Registers one agent tool, `doc_ocr_sign_fix`, plus a short system-prompt
 * section. It diagnoses and repairs the macOS code-signing condition that makes
 * the DSH built-in Python unable to load native extensions (onnxruntime / cv2 /
 * pypdfium2): ad-hoc + hardened runtime + Library Validation requires a matching
 * Team ID, which pip wheels do not have. The fix injects
 * `com.apple.security.cs.disable-library-validation` and re-signs the interpreter.
 *
 * Keeps ZERO runtime npm dependencies (mirrors dsh-ocr / dsh-context-extract).
 *
 * @module dsh-macos-signfix
 */
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { runSignFix } from './runner.js'

/** Cordis plugin name. */
export const name = 'dsh-macos-signfix'

/** Required host services: tool registry + prompt assembly. */
export const inject = ['tools', 'systemPrompt']

const HERE = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ */
/* defineTool (structure-compatible reimplementation of the SDK's)     */
/* ------------------------------------------------------------------ */

function compileValue(spec) {
  const node = {}
  if (typeof spec.description === 'string' && spec.description.length > 0) node.description = spec.description
  const type = spec.type
  if (type === undefined || type === 'json') return node
  if (type === 'object') {
    node.type = 'object'
    node.additionalProperties = spec.additionalProperties
    if (spec.properties !== undefined) node.properties = compilePropertyMap(spec.properties).properties
    return node
  }
  if (type === 'array') {
    node.type = 'array'
    if (spec.items !== undefined) node.items = compileValue(spec.items)
    return node
  }
  node.type = type
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  if (spec.const !== undefined) node.const = spec.const
  return node
}

function compilePropertyMap(spec) {
  const properties = {}
  const required = []
  for (const [key, entry] of Object.entries(spec)) {
    const { required: isRequired, ...valueSpec } = entry
    properties[key] = compileValue(valueSpec)
    if (isRequired === true) required.push(key)
  }
  return required.length > 0 ? { properties, required } : { properties }
}

function matchesScalarType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function validateValue(schema, value, path) {
  if (typeof schema.type !== 'string' || schema.type.length === 0) return []
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} must be an object`]
    const violations = []
    for (const key of schema.required ?? []) if (!(key in value)) violations.push(`${path}.${key} is required`)
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(value)) if (!known.has(key)) violations.push(`${path}.${key} is not a declared property`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) violations.push(...validateValue(child, value[key], `${path}.${key}`))
    }
    return violations
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    const violations = []
    if (schema.items !== undefined) value.forEach((item, i) => violations.push(...validateValue(schema.items, item, `${path}[${i}]`)))
    return violations
  }
  if (!matchesScalarType(value, schema.type)) return [`${path} must be ${schema.type}`]
  if (schema.enum !== undefined && !schema.enum.some((v) => v === value)) return [`${path} must be one of ${schema.enum.map(String).join(', ')}`]
  if (schema.const !== undefined && schema.const !== value) return [`${path} must be ${String(schema.const)}`]
  return []
}

function defineTool(options) {
  const compiled = compilePropertyMap(options.parameters)
  const parameters = { type: 'object', properties: compiled.properties }
  if (compiled.required !== undefined) parameters.required = compiled.required
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: {},
      render(args, value) {
        return options.output.render(args, value)
      },
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, 'arguments')
      if (violations.length > 0) throw new Error(`Error: invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    },
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function renderSignFix(_args, value) {
  if (value === null || typeof value !== 'object') return [{ type: 'text', text: String(value) }]
  if (value.error !== undefined || value.ok === false) {
    return [{ type: 'text', text: `sign-fix 失败：${value.error ?? JSON.stringify(value).slice(0, 500)}` }]
  }
  const lines = [`# doc_ocr_sign_fix · ${value.mode ?? 'auto'}`, `interpreter: ${value.pythonPath ?? '?'}`]
  if (value.action) lines.push(`action: ${value.action}`)
  const d = value.diagnose ?? value
  if (d?.signature) {
    lines.push('', '## 签名状态')
    lines.push(`- signed=${d.signature.signed} adhoc=${d.signature.adhoc} runtime=${d.signature.runtime} flags=${d.signature.flags}`)
    lines.push(`- team=${d.signature.teamIdentifier}`)
    lines.push(`- disable-library-validation=${d.signature.hasDisableLibraryValidation}`)
    lines.push(`- imports ok=${d.imports?.ok} errors=${(d.imports?.errors ?? []).join(',') || '-'}`)
  }
  if (value.sign) {
    const s = value.sign
    lines.push('', `## 签名执行`, `- changed=${s.changed} reason=${s.reason ?? '-'}`)
    if (s.backupDir) lines.push(`- backup=${s.backupDir}`)
    if (s.before?.flags) lines.push(`- before: flags=${s.before.flags} team=${s.before.teamIdentifier}`)
    if (s.after?.flags) lines.push(`- after:  flags=${s.after.flags} team=${s.after.teamIdentifier}`)
    if (s.after?.importErrors?.length) lines.push(`- after import errors: ${s.after.importErrors.join(',')}`)
    if (s.note) lines.push(`- ${s.note}`)
  }
  if (value.verify) {
    const v = value.verify
    lines.push('', `## 验证`, `- shallow ok=${v.shallow?.ok} exit=${v.shallow?.exitCode}`)
    for (const ln of v.shallow?.output ?? []) lines.push(`  ${ln}`)
    if (v.deep) lines.push(`- deep ok=${v.deep.ok} ${(v.deep.output ?? []).join(' ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/* ------------------------------------------------------------------ */
/* plugin apply                                                        */
/* ------------------------------------------------------------------ */

const PROMPT_SECTION = `## macOS 签名修复（doc_ocr_sign_fix）

当 doc_ocr / OCR 引擎报 \`code signature ... different Team IDs\` 或 \`library load disallowed\`，说明 DSH 内置 Python 的 hardened runtime + Library Validation 拒绝了 pip wheel 里的 ad-hoc 原生扩展（onnxruntime / cv2 / pypdfium2）。

先 \`doc_ocr_sign_fix(mode="diagnose")\` 看签名状态，再 \`doc_ocr_sign_fix(mode="auto")\` 自动修复（注入 disable-library-validation entitlement + ad-hoc 重签解释器，幂等、带备份），最后 \`mode="verify", deep=true\` 跑一次最小 RapidOCR 推理。

注意：**不要**对 Electron .app 用 \`codesign --deep\`；本工具只重签 Python 解释器，不碰外层 App。每次 DSH Desktop 升级后可能需重跑一次 \`auto\`。`

export function apply(ctx) {
  const disposers = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'doc_ocr_sign_fix',
    description: 'Diagnose and repair the macOS code-signing condition that stops the DSH built-in Python from loading native extensions (onnxruntime / cv2 / pypdfium2). Modes: diagnose (report signature + import errors), sign (inject disable-library-validation entitlement + ad-hoc re-sign interpreter, idempotent, backed up), verify (import check, optionally deep RapidOCR inference), auto (diagnose → sign if needed → verify). Never touches the enclosing Electron .app.',
    parameters: {
      pythonPath: {
        type: 'string',
        description: 'Interpreter to fix (default: DSH built-in primary-runtime python3).',
      },
      mode: {
        type: 'string',
        enum: ['diagnose', 'sign', 'verify', 'auto'],
        description: 'Operation. auto (default) = diagnose → sign if needed → verify.',
      },
      force: {
        type: 'boolean',
        description: 'Re-sign even if already fixed (default false → idempotent no-op when healthy).',
      },
      deep: {
        type: 'boolean',
        description: 'Deep verify: instantiate RapidOCR and run one tiny inference (slower, proves the pipeline).',
      },
      resignExtensions: {
        type: 'boolean',
        description: 'Also re-sign onnxruntime/cv2/pypdfium2 native extensions ad-hoc (optional; interpreter entitlement alone usually enough).',
      },
    },
    output: { render: renderSignFix },
    async execute(args) {
      return runSignFix({
        pythonPath: args.pythonPath,
        mode: args.mode,
        force: args.force,
        deep: args.deep,
        resignExtensions: args.resignExtensions,
        engineRoot: HERE,
      })
    },
  })))

  const disposeSection = ctx.systemPrompt.section({
    name: 'dsh-macos-signfix',
    order: 188,
    text: PROMPT_SECTION,
  })
  ctx.effect(() => disposeSection, 'dsh-macos-signfix: prompt section')

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-macos-signfix: tools')
}
