export type ApiErrorKind = 'network' | 'http' | 'validation' | 'protocol' | 'aborted'

export class ApiError extends Error {
  constructor(readonly kind: ApiErrorKind, message: string, readonly status?: number) {
    super(message)
    this.name = 'ApiError'
  }
}

interface Parser<T> { parse: (input: unknown) => T }
interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal | undefined
  acceptedStatuses?: readonly number[]
}

export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  let response: Response
  try {
    response = await fetch(path, {
      ...(options.method ? { method: options.method } : {}),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body), headers: { 'content-type': 'application/json' } }),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }
  catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError'))
      throw new ApiError('aborted', '请求已取消')
    throw new ApiError('network', '无法连接服务器')
  }
  if (response.ok || options.acceptedStatuses?.includes(response.status))
    return response
  let message = ''
  try {
    const text = await response.text()
    try {
      const body: unknown = JSON.parse(text)
      if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string')
        message = body.message
    }
    catch {
      message = text
    }
  }
  catch {
    // An HTTP status remains actionable even when its error body is unreadable.
  }
  throw new ApiError('http', message, response.status)
}

export async function requestJson<T>(path: string, schema: Parser<T>, options?: RequestOptions): Promise<T> {
  const response = await request(path, options)
  return parseResponse(response, schema, options?.signal)
}

export async function parseResponse<T>(response: Response, schema: Parser<T>, signal?: AbortSignal): Promise<T> {
  try {
    return schema.parse(await response.json())
  }
  catch {
    if (signal?.aborted)
      throw new ApiError('aborted', '请求已取消')
    throw new ApiError('protocol', '服务器返回的数据格式不正确', response.status)
  }
}

export function parseInput<T>(schema: Parser<T>, input: unknown, message: string): T {
  try {
    return schema.parse(input)
  }
  catch {
    throw new ApiError('validation', message)
  }
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError))
    return fallback
  if (error.kind === 'network' || error.kind === 'protocol')
    return `${fallback}：${error.message}`
  if (error.kind === 'validation')
    return error.message
  if (error.status === 401)
    return '登录已过期，请重新登录'
  if (error.status === 403)
    return /[\u4E00-\u9FFF]/u.test(error.message) ? error.message : '没有操作权限，请刷新后重试'
  if (error.status === 503)
    return '持久化未启用'
  return /[\u4E00-\u9FFF]/u.test(error.message) ? error.message : fallback
}
