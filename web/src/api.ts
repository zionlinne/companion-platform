export type User = {
  id: string
  email: string
  displayName: string
  role: 'admin' | 'user'
}

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
      credentials: 'include',
      headers: {
        'X-Companion-Request': '1',
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    throw new ApiError(0, 'offline', '连不上服务。如果免费托管正在醒来，请稍等再试。')
  }
  const text = await response.text()
  const data = text ? (JSON.parse(text) as { error?: { code?: string; message?: string } }) : {}
  if (!response.ok) {
    throw new ApiError(response.status, data.error?.code ?? 'error', data.error?.message ?? '请求失败')
  }
  return data as T
}
