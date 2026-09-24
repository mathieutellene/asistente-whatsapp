// Perfil de cada chat: la IA lee el historico y resume la relacion, el tono y como escribes ahi.
// Se hace en segundo plano, solo cuando no hay borradores pendientes de redactar, para tus chats
// mas activos. Tus notas del panel mandan sobre el perfil.
import { pool } from './db.js'
import { chat as askModel, iaReady } from './ollama.js'
import { waStatus } from './whatsapp.js'

const PROFILE_FORMAT = {
  type: 'object',
  properties: {
    relacion: { type: 'string' }, tono: { type: 'string' }, como_escribes: { type: 'string' },
    temas: { type: 'string' }, datos: { type: 'string' }, evitar: { type: 'string' },
  },
  required: ['relacion', 'tono', 'como_escribes', 'temas', 'datos', 'evitar'],
}
export const PROFILE_LABELS = {
  relacion: 'Relacion', tono: 'Tono', como_escribes: 'Como escribes aqui', temas: 'Temas habituales', datos: 'Datos utiles', evitar: 'Evitar',
}

const TOP_CHATS = 40
export const profileStatus = { analizando: null, hechos: 0, cola: 0, ultimoError: null }
let isBusy = () => false
const priority = []

/** drafts.js indica cuando la IA esta ocupada con borradores (tienen prioridad). */
export const setBusyCheck = fn => { isBusy = fn }

export async function getProfile(chatId) {
  const { rows: [p] } = await pool.query('SELECT * FROM chat_profiles WHERE chat_id = $1', [chatId])
  return p || null
}

export async function saveNotes(chatId, notas) {
  await pool.query(
    `INSERT INTO chat_profiles (chat_id, notas) VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET notas = EXCLUDED.notas`, [chatId, notas || null])
}

/** Pide analizar un chat cuanto antes (boton "Analizar de nuevo"). */
export function requestProfile(chatId) {
  if (!priority.includes(chatId)) priority.push(chatId)
}

export function formatProfile(perfil) {
  if (!perfil) return ''
  return Object.entries(PROFILE_LABELS).map(([k, label]) => (perfil[k] ? `- ${label}: ${perfil[k]}` : null)).filter(Boolean).join('\n')
}

async function nextChat() {
  if (priority.length) return priority.shift()
  const { rows } = await pool.query(
    `WITH activos AS (
       SELECT chat_id, count(*)::int AS n FROM messages
       WHERE ts > now() - interval '6 months' GROUP BY chat_id
       HAVING count(*) FILTER (WHERE from_me) >= 5 ORDER BY count(*) DESC LIMIT ${TOP_CHATS})
     SELECT a.chat_id, a.n FROM activos a LEFT JOIN chat_profiles p ON p.chat_id = a.chat_id
     WHERE p.updated_at IS NULL OR a.n - p.msgs_count >= 150 OR p.updated_at < now() - interval '14 days'
     ORDER BY (p.updated_at IS NULL) DESC, a.n DESC LIMIT 1`)
  const { rows: [c] } = await pool.query(
    `WITH activos AS (SELECT chat_id FROM messages WHERE ts > now() - interval '6 months' GROUP BY chat_id
                      HAVING count(*) FILTER (WHERE from_me) >= 5 ORDER BY count(*) DESC LIMIT ${TOP_CHATS})
     SELECT count(*)::int AS n FROM activos a LEFT JOIN chat_profiles p ON p.chat_id = a.chat_id WHERE p.updated_at IS NULL`)
  profileStatus.cola = c.n
  return rows[0]?.chat_id || null
}

/** Analiza un chat y guarda su perfil. Exportado para las pruebas. */
export async function analyzeChat(chatId) {
  const { rows: [info] } = await pool.query(
    `SELECT COALESCE(ch.name, ct.name, ct.notify, split_part($1, '@', 1)) AS nombre, $1 LIKE '%@g.us' AS es_grupo,
            (SELECT count(*)::int FROM messages WHERE chat_id = $1) AS n
     FROM (SELECT $1::text AS id) x LEFT JOIN chats ch ON ch.chat_id = x.id LEFT JOIN contacts ct ON ct.jid = x.id`, [chatId])
  const { rows } = await pool.query(
    `SELECT m.from_me, m.ts, m.text, COALESCE(ct.name, m.sender_name, ct.notify, 'Alguien') AS quien
     FROM messages m LEFT JOIN contacts ct ON ct.jid = m.sender_jid
     WHERE m.chat_id = $1 ORDER BY m.ts DESC LIMIT 150`, [chatId])
  if (rows.length < 5) return null
  const me = waStatus.usuario || 'yo'
  const transcript = rows.reverse().map(m =>
    `[${new Date(m.ts).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}] ${m.from_me ? 'Tu' : m.quien}: ${m.text.slice(0, 200)}`).join('\n')
  const system = [
    `Analiza esta conversacion de WhatsApp entre ${me} ("Tu") y ${info.es_grupo ? `el grupo "${info.nombre}"` : info.nombre}.`,
    'Devuelve SOLO un JSON con estos campos, en espanol, frases cortas y concretas, sin inventar nada:',
    '- relacion: quien es para ti (familia, pareja, amigo, trabajo, cliente, grupo de...) y cuanta confianza hay',
    '- tono: como os hablais (formal/informal, bromas, carino, directo...)',
    '- como_escribes: TU estilo aqui (largo de mensajes, emojis, saludos, apodos, muletillas, tu o usted)',
    '- temas: de que soleis hablar',
    '- datos: hechos utiles para contestar bien (nombres, planes, gustos, sitios, compromisos pendientes)',
    '- evitar: lo que nunca harias en este chat',
  ].join('\n')
  const { text } = await askModel(
    [{ role: 'system', content: system }, { role: 'user', content: transcript }],
    { format: PROFILE_FORMAT, temperature: 0.3, numCtx: 8192, numPredict: 500 },
  )
  let perfil
  try {
    const end = text.toLowerCase().lastIndexOf('</think>')
    const raw = end >= 0 ? text.slice(end + '</think>'.length) : text
    perfil = JSON.parse(raw.slice(raw.indexOf('{')))
  } catch {
    throw new Error('la IA no devolvio un perfil valido')
  }
  const clean = Object.fromEntries(Object.keys(PROFILE_LABELS).map(k => [k, String(perfil[k] || '').slice(0, 400)]))
  await pool.query(
    `INSERT INTO chat_profiles (chat_id, perfil, msgs_count, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (chat_id) DO UPDATE SET perfil = EXCLUDED.perfil, msgs_count = EXCLUDED.msgs_count, updated_at = now()`,
    [chatId, clean, info.n])
  return clean
}

async function tick() {
  if (profileStatus.analizando || isBusy() || !iaReady()) return
  let chatId
  try {
    chatId = await nextChat()
    if (!chatId) return
    profileStatus.analizando = chatId
    await analyzeChat(chatId)
    profileStatus.hechos++
    profileStatus.ultimoError = null
  } catch (err) {
    profileStatus.ultimoError = err.message
    if (chatId) await pool.query( // no reintentar en bucle el mismo chat (se vuelve a probar en 14 dias o a mano)
      `INSERT INTO chat_profiles (chat_id, msgs_count, updated_at)
       VALUES ($1, (SELECT count(*)::int FROM messages WHERE chat_id = $1), now())
       ON CONFLICT (chat_id) DO UPDATE SET msgs_count = EXCLUDED.msgs_count, updated_at = now()`, [chatId]).catch(() => {})
  } finally {
    profileStatus.analizando = null
  }
}

export function startProfiles() {
  setTimeout(() => {
    tick()
    setInterval(tick, 30_000)
  }, 10 * 60_000) // deja terminar antes la carga del historico
}
