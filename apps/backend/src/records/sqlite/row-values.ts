export function requiredString(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('Unexpected non-string SQLite value')
  return value
}

export function nullableString(value: unknown): string | null {
  if (value === null)
    return null
  return requiredString(value)
}

export function requiredNumber(value: unknown): number {
  if (typeof value !== 'number')
    throw new Error('Unexpected non-number SQLite value')
  return value
}
