import net from 'node:net'
import { config } from './config.js'
import { pool, purgeJids } from './db.js'
import './drafts.js' // escucha los mensajes nuevos y prepara borradores
import { excludedJids, excludedNumbers } from './exclusions.js'
import { keepAwake } from './keepawake.js'
import { startOllama } from './ollama.js'
import { startPanel } from './panel/server.js'
import { startProfiles } from './profiles.js'
import { startTelegram } from './telegram.js'
import { startWhatsApp } from './whatsapp.js'

// Solo puede haber un asistente a la vez (dos chocarian en WhatsApp). Si el panel ya responde, salimos
// con el codigo 3 y iniciar.cmd cierra esta ventana en vez de reintentar.
const yaAbierto = await new Promise(resolve => {
  const s = net.connect(config.panelPort, '127.0.0.1')
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
  s.setTimeout(1500, () => { s.destroy(); resolve(false) })
})
if (yaAbierto) {
  console.log('Ya hay otro asistente funcionando en este ordenador. Esta ventana se cierra sola.')
  process.exit(3)
}

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
startProfiles()
startTelegram()
await startWhatsApp()

process.on('SIGINT', async () => {
  await pool.end()
  process.exit(0)
})
