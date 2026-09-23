// Estado de Tailscale: la red privada que permite abrir el panel desde el iPhone sin publicarlo en internet.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const WIN_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe'
export const tailscaleExe = () => (existsSync(WIN_EXE) ? WIN_EXE : 'tailscale')

const run = args => new Promise(resolve => {
  execFile(tailscaleExe(), args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout))
})

let cache = { at: 0, value: null }

/** { instalado, conectado, publicado, url } — cacheado 30 s. */
export async function tailscaleStatus() {
  if (cache.value && Date.now() - cache.at < 30_000) return cache.value
  const value = { instalado: false, conectado: false, publicado: false, url: null }
  const raw = await run(['status', '--json'])
  if (raw) {
    value.instalado = true
    try {
      const st = JSON.parse(raw)
      value.conectado = st.BackendState === 'Running'
      if (value.conectado && st.Self?.DNSName) value.url = `https://${st.Self.DNSName.replace(/\.$/, '')}/`
    } catch { /* salida inesperada */ }
    const serve = await run(['serve', 'status', '--json'])
    try {
      const s = JSON.parse(serve || '{}')
      value.publicado = !!(s.Web || s.TCP)
    } catch { /* sin serve */ }
  } else {
    value.instalado = existsSync(WIN_EXE)
  }
  if (!value.publicado) value.url = null
  cache = { at: Date.now(), value }
  return value
}
