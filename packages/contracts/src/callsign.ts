export const NO_CALLSIGN = 'N0CALL'
export const CALLSIGN_SECOND_LETTERS = 'ABDEGHIY'
export const CALLSIGN_PREFIX_SOURCE = `B[${CALLSIGN_SECOND_LETTERS}]`
export const CALLSIGN_SOURCE = String.raw`${CALLSIGN_PREFIX_SOURCE}\d[A-Z]{2,3}`
export const CALLSIGN_PATTERN = new RegExp(`^${CALLSIGN_SOURCE}$`)
export const MANUAL_CALLSIGN_PATTERN = new RegExp(`^(?:${CALLSIGN_SOURCE}|${NO_CALLSIGN})$`)
export const RECORD_CALLSIGN_FILTER_PATTERN = /^[A-Z0-9]{2,}$/
export const MAX_RECOGNITION_LENGTH = 1_000
export const REVIEW_CALLSIGN_REQUIRED_MESSAGE = '请先填写主叫呼号，再标注'
export const REVIEW_CALLSIGN_CLEAR_MESSAGE = '已标注记录需保留主叫呼号，请先取消标注'

export function hasCallerCallsign(record: { manualCallsign: string | null, callsign: string | null }): boolean {
  return Boolean(record.manualCallsign?.trim() || record.callsign?.trim())
}

export function isValidCallsign(value: string): boolean {
  return CALLSIGN_PATTERN.test(value)
}

export function isDisplayableCallsign(value: string): boolean {
  return value !== NO_CALLSIGN && isValidCallsign(value)
}
