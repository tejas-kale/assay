import { createRoot } from 'react-dom/client'

import { App } from './App.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing')
// No StrictMode: its double-mounted effects would create two terminals.
createRoot(root).render(<App />)
