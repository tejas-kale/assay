import { createRoot } from 'react-dom/client'

import { App } from './App.tsx'
import { Strip } from './components/Strip.tsx'
import { startAppearance } from './appearance.ts'
import './styles.css'

startAppearance()

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing')
// No StrictMode: its double-mounted effects would create two terminals.
createRoot(root).render(location.hash === '#strip' ? <Strip /> : <App />)
