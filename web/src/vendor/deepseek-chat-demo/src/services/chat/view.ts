/**
 * Shim. Upstream `view.ts` derives search timelines and is not part of this
 * product. Only the citation `Source` shape is kept so the vendored markdown
 * renderer type-checks. This file is not a copy of the upstream module.
 */
export type Source = {
  url: string
  title: string
  siteName: string
  publishedAt: string | null
  snippet: string | null
  siteIcon: string | null
  index: number
}
