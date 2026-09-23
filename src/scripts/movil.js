// Publica el panel SOLO dentro de tu red privada de Tailscale y muestra un QR para abrirlo en el iPhone.
import { execFileSync, spawnSync } from 'node:child_process'
import qrcode from 'qrcode-terminal'
import { config } from '../config.js'
import { tailscaleExe } from '../tailscale.js'

const exe = tailscaleExe()
const status = () => {
  try { return JSON.parse(execFileSync(exe, ['status', '--json'], { encoding: 'utf8', windowsHide: true })) } catch { return null }
}

let st = status()
if (!st) {
  console.log('Tailscale no esta instalado o no responde. Vuelve a pegar la linea de instalacion del correo.')
  process.exit(1)
}
if (st.BackendState !== 'Running') {
  console.log('\nPaso 1: inicia sesion en Tailscale en la pagina que se abre.')
  console.log('Usa una cuenta que tambien vayas a usar en el iPhone (por ejemplo, tu Google personal).\n')
  spawnSync(exe, ['up'], { stdio: 'inherit' })
  st = status()
}
if (st?.BackendState !== 'Running' || !st.Self?.DNSName) {
  console.log('Tailscale todavia no esta conectado. Vuelve a abrir movil.cmd cuando hayas iniciado sesion.')
  process.exit(1)
}

console.log('\nPaso 2: publicando el panel SOLO dentro de tu red privada de Tailscale...')
console.log('(Si aparece un enlace para activar HTTPS, abrelo y pulsa "Enable": es la primera vez.)\n')
const r = spawnSync(exe, ['serve', '--bg', String(config.panelPort)], { stdio: 'inherit' })
if (r.status !== 0) {
  console.log('\nNo se pudo publicar. Prueba a abrir movil.cmd con clic derecho > "Ejecutar como administrador".')
  process.exit(1)
}

const url = `https://${st.Self.DNSName.replace(/\.$/, '')}/`
console.log(`\nListo. Tu panel en el movil: ${url}\n`)
qrcode.generate(url, { small: true })
console.log('\nEn el iPhone:')
console.log('  1. Instala "Tailscale" desde la App Store y entra con la MISMA cuenta. Activalo.')
console.log('  2. Escanea este QR con la camara (o escribe la direccion en Safari).')
console.log('  3. En Safari: Compartir > "Anadir a pantalla de inicio" para tenerlo como una app.')
