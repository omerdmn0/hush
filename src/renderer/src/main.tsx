import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Fonts are bundled with the app — no requests to Google Fonts (MASTER.md §3).
import '@fontsource-variable/orbitron'
import '@fontsource-variable/exo-2'
import '@fontsource-variable/jetbrains-mono'
import './styles/globals.css'
import { TooltipProvider } from '@/components/ui/tooltip'
import App from './App'
import { LockScreen } from './components/LockScreen'

// The same page serves the small lock window (#lock) shown before Hush opens its data.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>{location.hash === '#lock' ? <LockScreen /> : <App />}</TooltipProvider>
  </StrictMode>
)
