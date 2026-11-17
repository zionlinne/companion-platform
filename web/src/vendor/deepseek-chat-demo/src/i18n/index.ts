/** Shim replacing the upstream settings-backed i18n store. */
const messages: Record<string, string> = {
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败，请长按或选中文本后复制',
  mermaidDiagram: '图表',
  mermaidCode: '代码',
  mermaidSwitchLabel: 'Mermaid 图表与代码切换',
}

export type TranslationKey = keyof typeof messages

export const useTranslate = () => (key: string) => messages[key] ?? key

export const translate = (key: string) => messages[key] ?? key
