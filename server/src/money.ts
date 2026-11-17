export const MARGIN_BPS_DEFAULT = 3000
export const PRESET_FEN = [500, 1000, 2000, 5000, 10000] as const

export function assertFen(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer fen amount`)
}

export function formatFen(fen: number): string {
  assertFen(fen, 'amount')
  const sign = fen < 0 ? '-' : ''
  const abs = Math.abs(fen)
  const whole = Math.floor(abs / 100)
  const fraction = abs % 100
  return `${sign}${whole}.${String(fraction).padStart(2, '0')}`
}

export function userChargeFen(costFen: number, marginBps: number): number {
  assertFen(costFen, 'cost')
  if (costFen < 0) throw new Error('cost cannot be negative')
  if (!Number.isSafeInteger(marginBps) || marginBps < 0 || marginBps >= 10_000) {
    throw new Error('margin basis points must be an integer from 0 up to but not including 10000')
  }
  if (costFen === 0) return 0
  const denominator = 10_000 - marginBps
  return Math.floor((costFen * 10_000 + denominator - 1) / denominator)
}

export function tokensToMinor(promptTokens: number, completionTokens: number, inputPerMillion: number, outputPerMillion: number): number {
  for (const [label, value] of [
    ['prompt tokens', promptTokens],
    ['completion tokens', completionTokens],
    ['input price', inputPerMillion],
    ['output price', outputPerMillion],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
  }
  const numerator = promptTokens * inputPerMillion + completionTokens * outputPerMillion
  return Math.floor((numerator + 1_000_000 - 1) / 1_000_000)
}

export function fenFromMicroUsd(microUsd: number, cnyFenPerUsd: number): number {
  assertFen(microUsd, 'micro-usd')
  assertFen(cnyFenPerUsd, 'fx')
  if (microUsd < 0 || cnyFenPerUsd < 0) throw new Error('conversion inputs cannot be negative')
  return Math.floor((microUsd * cnyFenPerUsd + 1_000_000 - 1) / 1_000_000)
}
