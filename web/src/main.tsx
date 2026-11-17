import Prism from 'prismjs'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const globalPrism = globalThis as { Prism?: typeof Prism }
globalPrism.Prism = Prism

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
