// Ajustes que se cambian desde el panel. Viven en %LOCALAPPDATA%\asistente-whatsapp\ajustes.json
// (fuera del escritorio/OneDrive y fuera de git), junto con los permisos de Google.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

const DEFAULTS = {
  telegram: { token: '', chatId: null, codigo: null, modo: 'aviso' }, // aviso = sin contenido
  ia: { modelo: null, opciones: 3 }, // modelo null = el de config; opciones = borradores alternativos
  // Contexto para los borradores: otros chats, Google, historial de Chrome, busqueda en internet
  fuentes: { chats: true, google: true, chrome: true, web: true },
  google: { clientId: '', clientSecret: '', tokens: null, email: null, pending: null },
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)

function load() {
  let saved = {}
  try { saved = JSON.parse(readFileSync(config.settingsFile, 'utf8')) } catch { /* primera vez */ }
  const out = structuredClone(DEFAULTS)
  for (const [k, v] of Object.entries(saved)) out[k] = isObj(v) && isObj(DEFAULTS[k]) ? { ...DEFAULTS[k], ...v } : v
  return out
}

let current = load()

export const settings = () => current

export function saveSettings(patch) {
  current = { ...current, ...patch }
  mkdirSync(dirname(config.settingsFile), { recursive: true })
  writeFileSync(config.settingsFile, JSON.stringify(current, null, 2))
  return current
}

/** Cambia una clave dentro de un grupo: patchSection('ia', { opciones: 1 }) */
export const patchSection = (section, patch) => saveSettings({ [section]: { ...current[section], ...patch } })
