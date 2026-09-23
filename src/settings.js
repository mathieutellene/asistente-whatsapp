// Ajustes que se cambian desde el panel (p. ej. Telegram). Viven en %LOCALAPPDATA%\asistente-whatsapp\ajustes.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

const DEFAULTS = {
  telegram: { token: '', chatId: null, codigo: null, modo: 'aviso' }, // aviso = sin contenido
}

function load() {
  try {
    const saved = JSON.parse(readFileSync(config.settingsFile, 'utf8'))
    return { ...DEFAULTS, ...saved, telegram: { ...DEFAULTS.telegram, ...saved.telegram } }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

let current = load()

export const settings = () => current

export function saveSettings(patch) {
  current = { ...current, ...patch }
  mkdirSync(dirname(config.settingsFile), { recursive: true })
  writeFileSync(config.settingsFile, JSON.stringify(current, null, 2))
  return current
}
