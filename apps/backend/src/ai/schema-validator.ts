import type { AnySchema } from 'ajv'
import { Ajv } from 'ajv'
import addFormats from 'ajv-formats'
import { Ajv2020 } from 'ajv/dist/2020.js'

// Compile once per loaded configuration. Ajv validates all supported keywords;
// unknown keywords and unresolved references fail during configuration loading.
export function compileSchema(schema: Record<string, unknown>): (value: unknown) => string | undefined {
  const options = { strictSchema: true, strictTypes: false, strictTuples: false, allErrors: true }
  const ajv = schema.$schema === 'https://json-schema.org/draft/2020-12/schema'
    || schema.$schema === undefined
    ? new Ajv2020(options)
    : new Ajv(options)
  addFormats.default(ajv)
  const validate = ajv.compile(schema as AnySchema)
  return (value) => {
    if (validate(value))
      return undefined
    return ajv.errorsText(validate.errors, { separator: '; ', dataVar: '$' })
  }
}

export function validateAgainstSchema(value: unknown, schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
    return 'Invalid JSON Schema'
  try {
    return compileSchema(schema as Record<string, unknown>)(value)
  }
  catch (error) {
    return `Invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`
  }
}
