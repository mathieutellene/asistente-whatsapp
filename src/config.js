const dataDir = `${process.env.LOCALAPPDATA || '.'}/asistente-whatsapp`.replace(/\\/g, '/')

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  historyMonths: Number(process.env.HISTORY_MONTHS || 6),
  authDir: process.env.AUTH_DIR || './data/auth-whatsapp',
  logLevel: process.env.LOG_LEVEL || 'warn',
  // Secretos y ajustes: fuera del escritorio (OneDrive) y fuera de git
  dataDir,
  excludeFile: process.env.EXCLUDE_FILE || `${dataDir}/excluidos.txt`,
  settingsFile: process.env.SETTINGS_FILE || `${dataDir}/ajustes.json`,
  // Panel: solo escucha en este ordenador; el movil entra a traves de Tailscale
  panelPort: Number(process.env.PANEL_PORT || 8787),
  // IA local
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  // "instruct" contesta directamente; "qwen3:4b" a secas es la version que "piensa en voz alta"
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3:4b-instruct',
}

if (!config.databaseUrl) {
  console.error('Falta DATABASE_URL en el archivo .env (lo crea scripts\\setup.ps1).')
  process.exit(1)
}
