export type ApiErrorCondition =
  | 'unauthorized'
  | 'insufficientBalance'
  | 'tooLarge'
  | 'rateLimited'
  | 'serverBusy'
  | 'network'
  | 'other'

/** Status classification used by the copied reply notice. It does not call a provider. */
export const classifyStatus = (status: number | undefined): ApiErrorCondition => {
  if (status === 401) return 'unauthorized'
  if (status === 402) return 'insufficientBalance'
  if (status === 413) return 'tooLarge'
  if (status === 429) return 'rateLimited'
  if ((status ?? 0) >= 500) return 'serverBusy'
  return 'other'
}
