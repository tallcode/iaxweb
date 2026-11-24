export const audioInterferenceLabels: ReadonlyMap<string, string> = new Map([
  ['interference_tone', '存在明显的持续单音'],
  ['interference_high_band', '高频噪声较明显'],
  ['interference_hiss', '持续沙沙底噪'],
  ['interference_transient', '局部突发干扰'],
  ['interference_local', '明显局部干扰'],
])

export function formatRecordTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(new Date(iso))
}
