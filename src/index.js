import { pool, purgeJids } from './db.js'
import './drafts.js' // escucha los mensajes nuevos y prepara borradores
import { excludedJids, excludedNumbers } from './exclusions.js'
import { keepAwake } from './keepawake.js'
import { startOllama } from './ollama.js'
import { startPanel } from './panel/server.js'
import { startTelegram } from './telegram.js'
import { startWhatsApp } from './whatsapp.js'

// Al iniciar sesion en Windows, PostgreSQL puede tardar en arrancar: reintentamos hasta 2 minutos.
for (let intento = 1; ; intento++) {
  try {
    await pool.query('SELECT 1 FROM messages LIMIT 1')
    break
  } catch (err) {
    if (intento >= 24) {
      console.error('No puedo usar PostgreSQL:', err.message)
      console.error('Comprueba que el servicio PostgreSQL esta arrancado y que se ejecuto scripts\\setup.ps1.')
      process.exit(1)
    }
    await new Promise(r => setTimeout(r, 5000))
  }
}

// Antes de conectar: borrar cualquier resto de los numeros excluidos
const borrados = await purgeJids(excludedJids())
console.log(`Numeros excluidos: ${excludedNumbers.size}${borrados ? ` (borrados ${borrados} registros suyos que ya estaban guardados)` : ''}`)

keepAwake()
startPanel()
startOllama()
startTelegram()
await startWhatsApp()

process.on('SIGINT', async () => {
  await pool.end()
  process.exit(0)
})
