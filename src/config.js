export const config = {
  databaseUrl: process.env.DATABASE_URL,
  historyMonths: Number(process.env.HISTORY_MONTHS || 6),
  authDir: process.env.AUTH_DIR || './data/auth-whatsapp',
  logLevel: process.env.LOG_LEVEL || 'warn',
}

if (!config.databaseUrl) {
  console.error('Falta DATABASE_URL en el archivo .env (lo crea scripts\\setup.ps1).')
  process.exit(1)
}
