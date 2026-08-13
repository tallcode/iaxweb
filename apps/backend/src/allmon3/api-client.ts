import type { NodeConfig } from './types.js'
import { isRecord } from './definitions.js'

interface SuccessResponse<T> {
  SUCCESS: T
}

export class Allmon3ApiClient {
  private readonly baseUrl: URL
  private readonly requestTimeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(baseUrl: string, requestTimeoutMs: number, fetchFn: typeof fetch = fetch) {
    this.baseUrl = new URL(baseUrl)
    this.requestTimeoutMs = requestTimeoutMs
    this.fetchFn = fetchFn
  }

  nodeIds(): Promise<number[]> {
    return this.fetchSuccess<number[]>('master/node/listall')
  }

  overrides(): Promise<Record<string, string>> {
    return this.fetchSuccess<Record<string, string>>('master/ui/custom/overrides')
  }

  nodeConfig(node: string): Promise<NodeConfig> {
    return this.fetchSuccess<NodeConfig>(`master/node/${node}/config`)
  }

  statusWebSocketUrl(port: number): string {
    const url = new URL(`ws/${port}`, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }

  private async fetchSuccess<T>(path: string): Promise<T> {
    const response = await this.fetchFn(new URL(path, this.baseUrl), {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (!response.ok)
      throw new Error(`Allmon3 ${path} returned HTTP ${response.status}`)
    const body = await response.json() as unknown
    if (!isRecord(body) || !('SUCCESS' in body))
      throw new Error(`Allmon3 ${path} returned an invalid response`)
    return (body as unknown as SuccessResponse<T>).SUCCESS
  }
}
