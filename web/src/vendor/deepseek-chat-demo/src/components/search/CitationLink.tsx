import type { Source } from '../../services/chat/view.js'

/** Simplified citation marker. The upstream hover card is not vendored. */
export const CitationLink = ({ source }: { source: Source }) => (
  <a className="ds-markdown-cite" href={source.url} target="_blank" rel="noreferrer">
    {source.index}
  </a>
)
