import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import './turnstile.css'
import { applyTheme, getStoredTheme } from './theme.js'
import App from './App.jsx'
import SelectAccount from './pages/SelectAccount.jsx'

applyTheme(getStoredTheme())

// Simple routing based on pathname
const AppRouter = () => {
  const path = window.location.pathname
  
  if (path === '/select-account') {
    return <SelectAccount />
  }
  
  return <App />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>
)
