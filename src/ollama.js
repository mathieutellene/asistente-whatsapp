// Cliente de Ollama: la IA corre en este mismo ordenador (http://127.0.0.1:11434), sin internet.
// Se usa node:http y respuestas por partes (stream): fetch corta cualquier peticion que tarde
// mas de 5 minutos en empezar a responder, y una descarga de 2,5 GB o un PC lento lo superan.
import http from 'node:http'
import { config } from './config.js'
import { settings } from './settings.js'

/** Modelos que caben en 8 GB de RAM sin GPU. Se eligen desde el panel. */
export const MODELOS = [
  { id: 'qwen3:4b-instruct', nombre: 'Qwen3 4B Instruct', gb: 2.5, nota: 'El de ahora. El más rápido.' },
  { id: 'qwen3.5:4b', nombre: 'Qwen 3.5 4B', gb: 3.4, nota: 'Más nuevo (2026). Mejor español y comprensión. Recomendado.' },
  { id: 'gemma3:4b', nombre: 'Gemma 3 4B', gb: 3.3, nota: 'De Google. Redacción natural.' },
  { id: 'gemma4:e2b-it-qat', nombre: 'Gemma 4 E2B', gb: 4.3, nota: 'El más nuevo de Google (2026). Justo de RAM: cierra Chrome si va lento.' },
]

// Modelos anteriores que se borran solos al tener el elegido (el "thinking" que metia ruido)
const OLD_MODELS = ['qwen3:4b']

export const wantedModel = () => settings().ia?.modelo || config.ollamaModel

export const iaStatus = {
  disponible: false, instalado: false, descargando: false, progreso: null,
  modelo: wantedModel(), usando: null, instalados: [], descargas: {}, error: null,
}

const fullName = m => (m.includes(':') ? m : `${m}:latest`)

/** Peticion a Ollama. Con onLine, lee la respuesta linea a linea (JSON por linea). */
function request(path, { method = 'GET', body, onLine, idleMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let failed = false
    const fail = err => { if (!failed) { failed = true; reject(err) } }
    const payload = body ? JSON.stringify(body) : ''
    // content-length explicito: sin el, Node no manda el cuerpo en peticiones DELETE
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    const req = http.request(new URL(path, config.ollamaUrl), { method, headers }, res => {
      let buf = ''
      let last = null
      const handle = line => {
        let j
        try { j = JSON.parse(line) } catch { return }
        if (j.error) { fail(new Error(j.error)); req.destroy(); return }
        last = j
        onLine?.(j)
      }
      res.setEncoding('utf8')
      res.on('data', d => {
        buf += d
        if (!onLine) return
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) handle(line)
        }
      })
      res.on('end', () => {
        if (buf.trim()) handle(buf.trim())
        if (failed) return
        if (res.statusCode >= 400) fail(new Error(`Ollama ${path}: HTTP ${res.statusCode}`))
        else { failed = true; resolve(last) }
      })
    })
    req.setTimeout(idleMs, () => req.destroy(new Error('Ollama no contesta (tiempo de espera agotado)')))
    req.on('error', fail)
    req.end(payload || undefined)
  })
}

export async function checkOllama() {
  const wanted = wantedModel()
  iaStatus.modelo = wanted
  try {
    const { models = [] } = await request('/api/tags', { idleMs: 10_000 })
    const names = models.map(m => m.name || m.model)
    const has = name => names.includes(fullName(name))
    iaStatus.disponible = true
    iaStatus.instalados = names
    iaStatus.instalado = has(wanted)
    // Mientras se descarga el elegido, se usa otro que ya este instalado
    const fallback = [config.ollamaModel, ...MODELOS.map(m => m.id), ...OLD_MODELS].find(m => m !== wanted && has(m))
    iaStatus.usando = iaStatus.instalado ? wanted : fallback || null
    if (iaStatus.instalado) {
      for (const old of OLD_MODELS) {
        if (fullName(old) !== fullName(wanted) && has(old)) {
          await deleteModel(old).catch(() => {})
          console.log(`Borrado el modelo antiguo ${old} para liberar espacio.`)
        }
      }
    }
    if (!iaStatus.descargando) iaStatus.error = null
  } catch {
    Object.assign(iaStatus, { disponible: false, usando: null, error: 'Ollama no responde. Suele arrancar solo al iniciar sesion en Windows.' })
  }
  return iaStatus
}

/** Descarga un modelo mostrando el progreso en el panel. */
export async function pullModel(name) {
  if (iaStatus.descargas[name] !== undefined) return
  iaStatus.descargas[name] = 0
  iaStatus.descargando = true
  if (name === wantedModel()) iaStatus.progreso = 0
  console.log(`Descargando el modelo de IA ${name} (solo la primera vez, puede tardar)...`)
  let lastLog = 0
  try {
    await request('/api/pull', {
      method: 'POST',
      body: { model: name, name, stream: true },
      idleMs: 5 * 60_000,
      onLine: j => {
        if (!j.total || !j.completed) return
        const pct = Math.floor((100 * j.completed) / j.total)
        iaStatus.descargas[name] = pct
        if (name === wantedModel()) iaStatus.progreso = pct
        if (pct >= lastLog + 10) {
          lastLog = pct
          console.log(`  ${name}: ${pct}%`)
        }
      },
    })
    console.log(`Modelo ${name} listo.`)
  } catch (err) {
    iaStatus.error = `No se pudo descargar ${name} (se reintenta solo si es el elegido): ${err.message}`
  } finally {
    delete iaStatus.descargas[name]
    iaStatus.descargando = Object.keys(iaStatus.descargas).length > 0
    await checkOllama()
  }
}

export async function deleteModel(name) {
  await request('/api/delete', { method: 'DELETE', body: { model: name, name } })
}

export async function ensureModel() {
  await checkOllama()
  if (iaStatus.disponible && !iaStatus.instalado) await pullModel(wantedModel())
}

export function startOllama() {
  ensureModel()
  setInterval(() => { if (!iaStatus.descargas[wantedModel()]) ensureModel() }, 60_000)
}

/** Hay un modelo con el que redactar (el elegido o, mientras se descarga, otro instalado). */
export const iaReady = () => iaStatus.disponible && !!iaStatus.usando

// Por defecto se fuerza este JSON: asi el modelo no puede anadir explicaciones ni "pasos"
export const REPLY_FORMAT = {
  type: 'object',
  properties: { respuesta: { type: 'string' } },
  required: ['respuesta'],
}

/**
 * Pide una respuesta al modelo. Devuelve { text, ms, model }.
 * opts: model (otro modelo), temperature, keepAlive ('0' = liberar la RAM al terminar), format, numCtx
 */
export async function chat(messages, opts = {}) {
  const t0 = Date.now()
  const model = opts.model || iaStatus.usando || wantedModel()
  const body = {
    model,
    messages,
    stream: true,
    think: false, // sin "razonamiento" visible
    format: opts.format || REPLY_FORMAT,
    keep_alive: opts.keepAlive ?? '15m', // luego libera la RAM
    options: { temperature: opts.temperature ?? 0.6, num_ctx: opts.numCtx || 6144, num_predict: opts.numPredict || 260 },
  }
  const run = async () => {
    let text = ''
    // Hasta 5 min sin recibir nada (cargar el modelo y leer la conversacion en un PC lento)
    await request('/api/chat', { method: 'POST', body, idleMs: 5 * 60_000, onLine: j => { text += j.message?.content || '' } })
    return text
  }
  let text
  try {
    text = await run()
  } catch (err) {
    if (!/think/i.test(err.message)) throw err
    delete body.think // modelos que no aceptan el parametro
    text = await run()
  }
  return { text, ms: Date.now() - t0, model }
}
