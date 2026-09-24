// Construye el prompt de un borrador: tu estilo con esa persona + ejemplos reales + conversacion reciente.
import { pool } from './db.js'

const EMOJI = /\p{Extended_Pictographic}/gu
const clip = (s, n = 250) => (s && s.length > n ? s.slice(0, n) + '...' : s || '')
const hhmm = d => new Date(d).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const words = s => new Set((s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9ñ]{4,}/g) || [])

export async function chatInfo(chatId) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(ch.name, ct.name, ct.notify, split_part($1, '@', 1)) AS nombre,
            COALESCE(ch.is_group, $1 LIKE '%@g.us') AS es_grupo
     FROM (SELECT $1::text AS id) x
     LEFT JOIN chats ch ON ch.chat_id = x.id
     LEFT JOIN contacts ct ON ct.jid = x.id`, [chatId])
  return r
}

/** Estadisticas de como escribes tu (en ese chat o, si hay pocos mensajes, en general). */
async function myStyle(chatId) {
  let { rows } = await pool.query(
    `SELECT text FROM messages WHERE chat_id = $1 AND from_me AND text NOT LIKE '[%' ORDER BY ts DESC LIMIT 200`, [chatId])
  let scope = 'con esta persona'
  if (rows.length < 8) {
    ;({ rows } = await pool.query(
      `SELECT text FROM messages WHERE from_me AND text NOT LIKE '[%' AND chat_id NOT LIKE '%@g.us' ORDER BY ts DESC LIMIT 300`))
    scope = 'en general'
  }
  const texts = rows.map(r => r.text)
  if (!texts.length) return null
  const lens = texts.map(t => t.length).sort((a, b) => a - b)
  const emojiCount = new Map()
  let withEmoji = 0
  for (const t of texts) {
    const found = t.match(EMOJI)
    if (found) withEmoji++
    for (const e of found || []) emojiCount.set(e, (emojiCount.get(e) || 0) + 1)
  }
  const all = texts.join('\n').toLowerCase()
  return {
    scope,
    median: lens[Math.floor(lens.length / 2)],
    emojiPct: Math.round((100 * withEmoji) / texts.length),
    topEmojis: [...emojiCount].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e),
    usted: /\busted(es)?\b/.test(all),
    risas: (all.match(/\b(ja){2,}|\b(je){2,}|\bxd\b/g) || []).length > texts.length * 0.05,
    minusculas: texts.filter(t => /^[a-zñ]/.test(t)).length > texts.length * 0.6,
  }
}

/** Parejas reales "te escriben → contestas" de este chat, anteriores a la conversacion reciente. */
async function examples(chatId, beforeTs, incomingText) {
  const { rows } = await pool.query(
    `WITH seq AS (
       SELECT from_me, text, ts, lag(from_me) OVER w AS prev_me, lag(text) OVER w AS prev_text, lag(ts) OVER w AS prev_ts
       FROM messages WHERE chat_id = $1 WINDOW w AS (ORDER BY ts))
     SELECT prev_text AS ellos, text AS yo FROM seq
     WHERE from_me AND prev_me = false AND ts < $2 AND ts - prev_ts < interval '6 hours'
       AND text NOT LIKE '[%' AND prev_text NOT LIKE '[%'
     ORDER BY ts DESC LIMIT 40`, [chatId, beforeTs])
  const target = words(incomingText)
  const scored = rows.map((r, i) => ({ ...r, i, score: [...words(r.ellos)].filter(w => target.has(w)).length }))
  const similar = scored.filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 3)
  const recent = scored.filter(r => !similar.includes(r)).slice(0, 6 - similar.length)
  return [...similar, ...recent].sort((a, b) => b.i - a.i)
}

export async function buildPrompt(chatId, meName = 'yo') {
  const info = await chatInfo(chatId)
  const { rows: recentDesc } = await pool.query(
    `SELECT m.from_me, m.ts, m.text, COALESCE(ct.name, m.sender_name, ct.notify, 'Alguien') AS quien
     FROM messages m LEFT JOIN contacts ct ON ct.jid = m.sender_jid
     WHERE m.chat_id = $1 ORDER BY m.ts DESC LIMIT 20`, [chatId])
  const recent = recentDesc.reverse()
  const lastIncoming = [...recent].reverse().find(m => !m.from_me)
  const style = await myStyle(chatId)
  const ex = recent.length ? await examples(chatId, recent[0].ts, lastIncoming?.text) : []

  const where = info.es_grupo ? `el grupo de WhatsApp "${info.nombre}"` : `tu chat de WhatsApp con ${info.nombre}`
  const rules = [
    `Eres ${meName} y vas a escribir tu siguiente mensaje en ${where}.`,
    'Devuelve SOLO este JSON: {"respuesta": "<tu mensaje>"}. Dentro va unicamente el texto que enviarias:',
    'sin explicar lo que vas a hacer, sin razonar, sin comillas extra, sin "Yo:" delante y sin firmar.',
  ]
  if (style) {
    rules.push(`Imita tu forma real de escribir ${style.scope}:`)
    rules.push(`- Largo habitual: unos ${style.median} caracteres. No te alargues mas de lo que sueles.`)
    rules.push(style.emojiPct >= 15
      ? `- Usas emojis en ${style.emojiPct}% de tus mensajes${style.topEmojis.length ? ` (sobre todo ${style.topEmojis.join(' ')})` : ''}.`
      : '- Casi nunca usas emojis.')
    if (style.usted) rules.push('- A veces tratas de usted: mira los ejemplos para saber si aqui toca.')
    if (style.risas) rules.push('- Sueles reirte por escrito (jaja, jeje...).')
    if (style.minusculas) rules.push('- Sueles empezar en minuscula.')
  }
  rules.push('No inventes datos concretos (fechas, horas, sitios, cifras, compromisos) que no salgan en la conversacion: si hace falta uno, escribe [completar].')
  rules.push('Contesta en el idioma de la conversacion y a lo ultimo que te han dicho.')

  const parts = []
  if (ex.length) {
    parts.push('Ejemplos reales de como contestas en este chat:')
    for (const e of ex) parts.push(`Ellos: ${clip(e.ellos, 160)}\nTu: ${clip(e.yo, 160)}`)
    parts.push('---')
  }
  parts.push('Conversacion reciente:')
  for (const m of recent) parts.push(`[${hhmm(m.ts)}] ${m.from_me ? 'Tu' : m.quien}: ${clip(m.text)}`)
  parts.push('---', 'Escribe ahora tu respuesta.')

  return { system: rules.join('\n'), user: parts.join('\n'), nombre: info.nombre, esGrupo: info.es_grupo }
}

/** Saca el mensaje de la salida del modelo: JSON {"respuesta"}, sin razonamiento previo. */
export function extractReply(raw) {
  let t = String(raw || '')
  const end = t.toLowerCase().lastIndexOf('</think>') // modelos "thinking": todo lo anterior es razonamiento
  if (end >= 0) t = t.slice(end + '</think>'.length)
  t = t.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const j = JSON.parse(t)
    if (typeof j?.respuesta === 'string') return j.respuesta
  } catch {
    const m = t.match(/"respuesta"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (m) {
      try { return JSON.parse(`"${m[1]}"`) } catch { return m[1] }
    }
  }
  return t
}

/** Limpia lo que devuelve el modelo. */
export function cleanDraft(text, meName = '') {
  let t = extractReply(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const names = ['tu', 'tú', 'yo']
  if (meName) names.push(meName.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&'))
  t = t.replace(new RegExp('^(' + names.join('|') + ')\\s*:\\s*', 'i'), '')
  t = t.replace(/^\[[^\]]*\]\s*/, '') // "[12/09 10:00]" copiado del formato
  t = t.replace(/^["'«“](.*)["'»”]$/s, '$1').trim()
  return t
}
