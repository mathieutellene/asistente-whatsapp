// Cliente de Ollama: la IA corre en este mismo ordenador (http://127.0.0.1:11434), sin internet.
import { config } from './config.js'

export const iaStatus = {
  disponible: false, instalado: false, descargando: false, modelo: config.ollamaModel, error: null,
}

async function api(path, body, timeoutMs = 10_000) {
  const res = await fetch(config.ollamaUrl + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Ollama ${path}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim())
  return res.json()
}

export async function checkOllama() {
  try {
    const { models = [] } = await api('/api/tags')
    const wanted = config.ollamaModel.includes(':') ? config.ollamaModel : `${config.ollamaModel}:latest`
    iaStatus.disponible = true
    iaStatus.instalado = models.some(m => m.name === wanted || m.model === wanted)
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

/** Pide una respuesta al modelo. Devuelve { text, ms }. */
export async function chat(messages) {
  const t0 = Date.now()
  const body = {
    model: config.ollamaModel,
    messages,
    stream: false,
    think: false, // qwen3: sin "razonamiento" visible, mas rapido
    keep_alive: '15m', // luego libera la RAM
    options: { temperature: 0.7, num_ctx: 4096, num_predict: 220 },
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
