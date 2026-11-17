/// <reference types="vite/client" />

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'

declare module 'prismjs/components/*' {
  const value: unknown
  export default value
}

declare module 'katex/contrib/mhchem'
