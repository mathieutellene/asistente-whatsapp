// Borradores: decide cuando preparar uno, lo genera con la IA local y lo guarda. NUNCA envia nada.
import { pool } from './db.js'
import { bus } from './events.js'
import { chat as askModel, iaReady } from './ollama.js'
import { setBusyCheck } from './profiles.js'
import { settings } from './settings.js'
import { buildPrompt, cleanDraft } from './style.js'
import { notifyDraft } from './telegram.js'
import { getMe, waStatus } from './whatsapp.js'

const DEBOUNCE_MS = 45_000 // espera a que la persona termine de escribir (varios mensajes seguidos)
const TEMPERATURES = [0.6, 0.85, 1.0] // opcion 1 mas "segura", las siguientes mas variadas
const timers = new Map()
const queue = [] // [{ chatId, models? }]
let running = false
let backlogDone = false

export const draftStatus = { cola: 0, generando: null, ultimoError: null, ultimoMs: null }
setBusyCheck(() => running || queue.length > 0) // los perfiles esperan a que no haya borradores

/**
 * Pone un chat en la cola de borradores (tambien lo usan los botones del panel).
 * models: para comparar, una opcion con cada modelo indicado.
 */
export function requestDraft(chatId, { models } = {}) {
  if (models?.length) queue.push({ chatId, models })
  else if (!queue.some(q => q.chatId === chatId && !q.models)) queue.push({ chatId })
  draftStatus.cola = queue.length
  pump()
}

async function pump() {
  if (running) return
  running = true
  try {
    while (queue.length) {
      if (!iaReady()) {
        setTimeout(pump, 60_000) // la IA aun no esta lista (descargando el modelo, Ollama cerrado...)
        return
      }
      const job = queue.shift()
      draftStatus.cola = queue.length
      draftStatus.generando = job.chatId
      try {
        await generate(job.chatId, job)
        draftStatus.ultimoError = null
      } catch (err) {
        draftStatus.ultimoError = err.message
        console.error('No se pudo preparar un borrador:', err.message)
      }
    }
  } finally {
    running = false
    draftStatus.generando = null
  }
}

async function lastMessage(chatId) {
  const { rows: [m] } = await pool.query(
    'SELECT msg_id, from_me, ts FROM messages WHERE chat_id = $1 ORDER BY ts DESC LIMIT 1', [chatId])
  return m
}

/** Genera el borrador (con varias opciones) y lo guarda. Exportado para las pruebas. */
export async function generate(chatId, { models } = {}) {
  const last = await lastMessage(chatId)
  if (!last || last.from_me) return null // ya has contestado
  const me = waStatus.usuario || 'yo'
  const prompt = await buildPrompt(chatId, me)
  const messages = [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]
  const n = models?.length || Math.max(1, Math.min(3, Number(settings().ia?.opciones) || 1))
  const alternativas = []
  let total = 0
  for (let i = 0; i < n; i++) {
    const r = await askModel(messages, models
      ? { model: models[i], keepAlive: '0' } // comparando: libera la RAM entre modelos
      : { temperature: TEMPERATURES[i] })
    total += r.ms
    const texto = cleanDraft(r.text, me)
    if (texto && !alternativas.some(a => a.texto === texto)) alternativas.push({ texto, modelo: r.model, ms: r.ms })
    const now = await lastMessage(chatId)
    if (!now || now.from_me) return null // contestaste mientras la IA pensaba
  }
  if (!alternativas.length) throw new Error('la IA devolvio un texto vacio')
  const again = await lastMessage(chatId)
  await pool.query(`UPDATE drafts SET status = 'reemplazado', updated_at = now() WHERE chat_id = $1 AND status = 'pendiente'`, [chatId])
  const { rows: [d] } = await pool.query(
    `INSERT INTO drafts (chat_id, trigger_msg_id, text, model, gen_ms, alternativas, contexto)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [chatId, again.msg_id, alternativas[0].texto, alternativas[0].modelo, total,
      JSON.stringify(alternativas), JSON.stringify(prompt.usado)])
  draftStatus.ultimoMs = total
  console.log(`Borrador listo para ${prompt.nombre}: ${alternativas.length} opcion(es) en ${Math.round(total / 1000)} s.`)
  notifyDraft({ id: d.id, chatId, nombre: prompt.nombre, text: alternativas[0].texto }).catch(() => {})
  return d.id
}

const TRIVIAL = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s.!]*$/u

/** ¿Merece la pena preparar un borrador automaticamente para este mensaje? */
async function shouldDraft(msg) {
  const t = msg.text || ''
  if (TRIVIAL.test(t) || /^\[(sticker|nota de voz|audio|foto|video|gif|ubicacion)[^\]]*\]$/.test(t)) return false
  if (t.length <= 3 && !t.includes('?')) return false // "ok", "si"...
  const { rows: [chat] } = await pool.query('SELECT archived, muted_until FROM chats WHERE chat_id = $1', [msg.chat_id])
  if (chat?.archived || (chat?.muted_until && new Date(chat.muted_until) > new Date())) return false
  if (!msg.chat_id.endsWith('@g.us')) return true
  // Grupos: solo si te mencionan o responden a un mensaje tuyo
  const me = getMe()
  if (msg.mentions?.some(j => j === me.pn || j === me.lid)) return true
  if (msg.quoted_id) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM messages WHERE chat_id = $1 AND msg_id = $2 AND from_me', [msg.chat_id, msg.quoted_id])
    if (rowCount) return true
  }
  return false
}

async function markAnswered(chatId, myText) {
  clearTimeout(timers.get(chatId))
  timers.delete(chatId)
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].chatId === chatId) queue.splice(i, 1)
  draftStatus.cola = queue.length
  await pool.query(
    `UPDATE drafts SET status = CASE WHEN status = 'usado' THEN 'usado' ELSE 'respondido' END,
            my_reply = COALESCE(my_reply, $2), updated_at = now()
     WHERE chat_id = $1 AND status IN ('pendiente', 'usado') AND my_reply IS NULL`, [chatId, myText])
}

bus.on('mensajes', async ({ rows, live }) => {
  try {
    const lastByChat = new Map()
    for (const r of rows) {
      const prev = lastByChat.get(r.chat_id)
      if (!prev || r.ts >= prev.ts) lastByChat.set(r.chat_id, r)
    }
    for (const [chatId, msg] of lastByChat) {
      if (msg.from_me) {
        await markAnswered(chatId, msg.text)
        continue
      }
      if (!live || !(await shouldDraft(msg))) continue
      clearTimeout(timers.get(chatId))
      timers.set(chatId, setTimeout(() => { timers.delete(chatId); requestDraft(chatId) }, DEBOUNCE_MS))
    }
  } catch (err) {
    console.error('Error revisando mensajes nuevos:', err.message)
  }
})

// Al conectar: borradores para lo que llego con el ordenador apagado (chats individuales, ultimas 24 h).
bus.on('conectado', () => {
  if (backlogDone) return
  backlogDone = true
  setTimeout(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT p.chat_id FROM pendientes p
         WHERE NOT p.es_grupo AND p.ultimo_mensaje > now() - interval '24 hours'
           AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.chat_id = p.chat_id AND d.created_at >= p.ultimo_mensaje)
         ORDER BY p.ultimo_mensaje DESC LIMIT 10`)
      for (const r of rows) requestDraft(r.chat_id)
      if (rows.length) console.log(`Preparando ${rows.length} borrador(es) de mensajes recibidos mientras estaba apagado.`)
    } catch (err) {
      console.error('Error buscando pendientes:', err.message)
    }
  }, 3 * 60_000) // deja terminar primero la sincronizacion
})
