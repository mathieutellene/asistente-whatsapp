export const config = {
  databaseUrl: process.env.DATABASE_URL,
  historyMonths: Number(process.env.HISTORY_MONTHS || 6),
  authDir: process.env.AUTH_DIR || './data/auth-whatsapp',
  logLevel: process.env.LOG_LEVEL || 'warn',
  excludeFile: process.env.EXCLUDE_FILE
    || `${process.env.LOCALAPPDATA || '.'}/asistente-whatsapp/excluidos.txt`.replace(/\\/g, '/'),
}

if (!config.databaseUrl) {
  console.error('Falta DATABASE_URL en el archivo .env (lo crea scripts\\setup.ps1).')
  process.exit(1)
}
