const SENSITIVE_KEY = /password|token|authorization|api[-_]?key|secret|cookie|content|summary|body|prompt|reasoning|database|connection/i

export type LogFields = Record<string, unknown>

export type Logger = {
  info: (event: string, fields?: LogFields) => void
  error: (event: string, fields?: LogFields) => void
  lines: string[]
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[max-depth]'
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) out[key] = '[redacted]'
      else out[key] = redact(inner, depth + 1)
    }
    return out
  }
  if (typeof value === 'string') {
    if (/sk-[A-Za-z0-9_-]{6,}/.test(value) || /Bearer\s+\S+/.test(value) || /postgres(?:ql)?:\/\//i.test(value)) return '[redacted]'
    if (value.length > 500) return `${value.slice(0, 80)}…[truncated]`
  }
  return value
}

export function createLogger(sink?: (line: string) => void): Logger {
  const lines: string[] = []
  const write = (level: string, event: string, fields?: LogFields) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(redact(fields ?? {}) as LogFields),
    })
    lines.push(line)
    if (sink) sink(line)
    else if (level === 'error') console.error(line)
    else console.log(line)
  }
  return {
    lines,
    info: (event, fields) => write('info', event, fields),
    error: (event, fields) => write('error', event, fields),
  }
}
