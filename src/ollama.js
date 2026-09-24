// Cliente de Ollama: la IA corre en este mismo ordenador (http://127.0.0.1:11434), sin internet.
// Se usa node:http y respuestas por partes (stream): fetch corta cualquier peticion que tarde
// mas de 5 minutos en empezar a responder, y una descarga de 2,5 GB o un PC lento lo superan.
import http from 'node:http'
import { config } from './config.js'

// Modelos anteriores: se usan mientras se descarga el nuevo y despues se borran
const OLD_MODELS = ['qwen3:4b']

export const iaStatus = {
  disponible: false, instalado: false, descargando: false, progreso: null,
  modelo: config.ollamaModel, usando: null, error: null,
}

const fullName = m => (m.includes(':') ? m : `${m}:latest`)

/** Peticion a Ollama. Con onLine, lee la respuesta linea a linea (JSON por linea). */
function request(path, { method = 'GET', body, onLine, idleMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let failed = false
    const fail = err => { if (!failed) { failed = true; reject(err) } }
    const req = http.request(new URL(path, config.ollamaUrl), { method, headers: { 'content-type': 'application/json' } }, res => {
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
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

export async function checkOllama() {
  try {
    const { models = [] } = await request('/api/tags', { idleMs: 10_000 })
    const has = name => models.some(m => m.name === fullName(name) || m.model === fullName(name))
    iaStatus.disponible = true
    iaStatus.instalado = has(config.ollamaModel)
    const oldAvailable = OLD_MODELS.find(o => fullName(o) !== fullName(config.ollamaModel) && has(o))
    iaStatus.usando = iaStatus.instalado ? config.ollamaModel : oldAvailable || null
    if (iaStatus.instalado && oldAvailable) {
      await request('/api/delete', { method: 'DELETE', body: { model: oldAvailable, name: oldAvailable } }).catch(() => {})
      console.log(`Borrado el modelo antiguo ${oldAvailable} para liberar espacio.`)
    }
    if (!iaStatus.descargando) iaStatus.error = null
  } catch {
    Object.assign(iaStatus, { disponible: false, usando: null, error: 'Ollama no responde. Suele arrancar solo al iniciar sesion en Windows.' })
  }
  return iaStatus
}

/** Descarga el modelo la primera vez (unos 2,5 GB), mostrando el progreso en el panel. */
export async function ensureModel() {
  await checkOllama()
  if (!iaStatus.disponible || iaStatus.instalado || iaStatus.descargando) return
  Object.assign(iaStatus, { descargando: true, progreso: 0, error: null })
  console.log(`Descargando el modelo de IA ${config.ollamaModel} (solo la primera vez, puede tardar)...`)
  let lastLog = 0
  try {
    await request('/api/pull', {
      method: 'POST',
      body: { model: config.ollamaModel, name: config.ollamaModel, stream: true },
      idleMs: 5 * 60_000,
      onLine: j => {
        if (j.total && j.completed) {
          iaStatus.progreso = Math.floor((100 * j.completed) / j.total)
          if (iaStatus.progreso >= lastLog + 10) {
            lastLog = iaStatus.progreso
            console.log(`  modelo de IA: ${iaStatus.progreso}%`)
          }
        }
      },
    })
    await checkOllama()
    console.log(iaStatus.instalado ? 'Modelo de IA listo.' : 'La descarga termino pero el modelo no aparece; se reintentara.')
  } catch (err) {
    iaStatus.error = `No se pudo descargar el modelo (se reintenta solo): ${err.message}`
  } finally {
    iaStatus.descargando = false
  }
}

export function startOllama() {
  ensureModel()
  setInterval(ensureModel, 60_000)
}

/** Hay un modelo con el que redactar (el nuevo o, mientras se descarga, el anterior). */
export const iaReady = () => iaStatus.disponible && !!iaStatus.usando

// La respuesta se fuerza a este JSON: asi el modelo no puede anadir explicaciones ni "pasos"
const REPLY_FORMAT = {
  type: 'object',
  properties: { respuesta: { type: 'string' } },
  required: ['respuesta'],
}

/** Pide una respuesta al modelo. Devuelve { text, ms, model } (text = JSON {"respuesta": ...} o texto). */
export async function chat(messages) {
  const t0 = Date.now()
  const model = iaStatus.usando || config.ollamaModel
  const body = {
    model,
    messages,
    stream: true,
    think: false, // sin "razonamiento" visible, mas rapido
    format: REPLY_FORMAT,
    keep_alive: '15m', // luego libera la RAM
    options: { temperature: 0.6, num_ctx: 4096, num_predict: 220 },
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
