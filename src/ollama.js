// Cliente de Ollama: la IA corre en este mismo ordenador (http://127.0.0.1:11434), sin internet.
import { config } from './config.js'

export const iaStatus = {
  disponible: false, instalado: false, descargando: false, modelo: config.ollamaModel, error: null,
}

// Modelo que se usaba antes: se borra al tener el nuevo, para no ocupar 2,5 GB de mas
const OLD_MODELS = ['qwen3:4b']

async function api(path, body, timeoutMs = 10_000, method = body ? 'POST' : 'GET') {
  const res = await fetch(config.ollamaUrl + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Ollama ${path}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim())
  return res.json()
}

const fullName = m => (m.includes(':') ? m : `${m}:latest`)

export async function checkOllama() {
  try {
    const { models = [] } = await api('/api/tags')
    const has = name => models.some(m => m.name === fullName(name) || m.model === fullName(name))
    iaStatus.disponible = true
    iaStatus.instalado = has(config.ollamaModel)
    if (iaStatus.instalado) {
      for (const old of OLD_MODELS) {
        if (fullName(old) !== fullName(config.ollamaModel) && has(old)) {
          await api('/api/delete', { model: old, name: old }, 30_000, 'DELETE').catch(() => {})
          console.log(`Borrado el modelo antiguo ${old} para liberar espacio.`)
        }
      }
    }
    if (!iaStatus.descargando) iaStatus.error = null
  } catch {
    iaStatus.disponible = false
    iaStatus.error = 'Ollama no responde. Suele arrancar solo al iniciar sesion en Windows.'
  }
  return iaStatus
}

/** Descarga el modelo la primera vez (unos 2,5 GB). */
async function ensureModel() {
  await checkOllama()
  if (!iaStatus.disponible || iaStatus.instalado || iaStatus.descargando) return
  iaStatus.descargando = true
  console.log(`Descargando el modelo de IA ${config.ollamaModel} (solo la primera vez, puede tardar)...`)
  try {
    await api('/api/pull', { model: config.ollamaModel, name: config.ollamaModel, stream: false }, 3 * 3600_000)
    iaStatus.instalado = true
    iaStatus.error = null
    console.log('Modelo de IA listo.')
  } catch (err) {
    iaStatus.error = `No se pudo descargar el modelo: ${err.message}`
  } finally {
    iaStatus.descargando = false
  }
}

export function startOllama() {
  ensureModel()
  setInterval(ensureModel, 60_000)
}

export const iaReady = () => iaStatus.disponible && iaStatus.instalado

// La respuesta se fuerza a este JSON: asi el modelo no puede anadir explicaciones ni "pasos"
const REPLY_FORMAT = {
  type: 'object',
  properties: { respuesta: { type: 'string' } },
  required: ['respuesta'],
}

/** Pide una respuesta al modelo. Devuelve { text, ms } (text = JSON {"respuesta": ...} o texto). */
export async function chat(messages) {
  const t0 = Date.now()
  const body = {
    model: config.ollamaModel,
    messages,
    stream: false,
    think: false, // sin "razonamiento" visible, mas rapido
    format: REPLY_FORMAT,
    keep_alive: '15m', // luego libera la RAM
    options: { temperature: 0.6, num_ctx: 4096, num_predict: 220 },
  }
  let r
  try {
    r = await api('/api/chat', body, 10 * 60_000)
  } catch (err) {
    if (!/think/i.test(err.message)) throw err
    delete body.think // modelos que no aceptan el parametro
    r = await api('/api/chat', body, 10 * 60_000)
  }
  return { text: r.message?.content || '', ms: Date.now() - t0 }
}
