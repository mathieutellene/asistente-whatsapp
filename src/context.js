// Reune contexto para un borrador: calendario, Gmail, Drive, otros chats, historial de Chrome y,
// si hace falta, una busqueda en internet. Todo en solo lectura; lo unico que sale del Huawei es la
// consulta corta y anonima de la busqueda. Cada fuente se activa/desactiva en el panel.
import { chromeSearch } from './chrome.js'
import { pool } from './db.js'
import { calendarEvents, driveSearch, emailForPhone, gmailSearch, googleInfo } from './google.js'
import { chat as askModel } from './ollama.js'
import { settings } from './settings.js'
import { sanitizeQuery, webSearch } from './web.js'

const STOP = new Set(`para pero como esta este esto estas estos estan donde cuando porque tambien tengo tiene tienes tenemos
hola vale bueno buena buenas buenos gracias entonces ahora luego manana hacer hago haces puedes puedo podemos quieres quiero
sabes nada todo todos toda algo mucho muy mas desde hasta sobre entre ellos ellas nosotros vosotros usted ustedes cual quien
eso esa ese aqui alli vamos voy vas van estoy estas esta estamos sera seria hemos habia hace dime oye mira pues vale okay
that this with from have what your will just`.split(/\s+/))

const plain = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Palabras clave de un mensaje (las mas largas, sin palabras vacias). */
export function keywords(text, max = 4) {
  const seen = new Set()
  const out = []
  for (const w of (text || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []) {
    const p = plain(w)
    if (STOP.has(p) || seen.has(p) || /^\d+$/.test(p)) continue
    seen.add(p)
    out.push(w)
  }
  return out.sort((a, b) => b.length - a.length).slice(0, max)
}

const fecha = (d, allDay) => {
  const x = new Date(d)
  const dia = x.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit' })
  return allDay ? `${dia} (todo el dia)` : `${dia} ${x.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('tarda demasiado')), ms))])

// Solo se plantea buscar en internet si el mensaje parece pedir un dato (ahorra tiempo de IA)
const PIDE_DATO = /\?|horario|precio|cu[aá]nto|cu[aá]ndo|d[oó]nde|direcci[oó]n|tiempo hace|resultado|partido|abre|cierra|recomi[eé]nda|sabes (si|qu[eé]|cu[aá]l)|c[oó]mo se|qu[eé] es/i

const SEARCH_FORMAT = {
  type: 'object',
  properties: { buscar: { type: 'boolean' }, consulta: { type: 'string' } },
  required: ['buscar', 'consulta'],
}

/** La IA local decide si hace falta un dato publico y escribe una consulta SIN datos privados. */
export async function decideSearch(incoming) {
  const { text } = await askModel([
    {
      role: 'system',
      content: [
        'Decide si para contestar este mensaje de WhatsApp hace falta buscar un dato PUBLICO en internet',
        '(horarios, direcciones, resultados deportivos, noticias, precios, el tiempo, como llegar...).',
        'NO hace falta para temas personales, planes entre amigos, sentimientos, saludos o preguntas sobre ti.',
        'Si hace falta, escribe una consulta corta para un buscador, SIN nombres de personas, telefonos, correos ni ningun dato privado.',
        'Devuelve SOLO JSON: {"buscar": true|false, "consulta": "..."}',
      ].join('\n'),
    },
    { role: 'user', content: incoming.slice(0, 600) },
  ], { format: SEARCH_FORMAT, temperature: 0.1, numPredict: 60, numCtx: 2048 })
  try {
    const raw = text.slice(text.lastIndexOf('{'))
    const j = JSON.parse(raw)
    const consulta = sanitizeQuery(j.consulta)
    return j.buscar === true && consulta.length >= 3 ? consulta : null
  } catch {
    return null
  }
}

/**
 * @returns {{ lines: string[], usado: Record<string, number|string[]> }}
 */
export async function gatherContext({ chatId, esGrupo, incoming }) {
  const f = settings().fuentes || {}
  const words = keywords(incoming)
  const sections = {} // en orden fijo al final
  const usado = {}
  const put = (key, title, items) => {
    if (!items.length) return
    usado[key] = items.length
    sections[key] = [title, ...items.map(i => `- ${i}`)]
  }
  const tasks = []

  if (f.google !== false && googleInfo().conectado) {
    tasks.push(['calendario', async () => {
      const evs = await calendarEvents({ days: 7 })
      if (words.length) {
        for (const e of await calendarEvents({ days: 60, q: words[0] })) if (!evs.some(x => x.inicio === e.inicio && x.titulo === e.titulo)) evs.push(e)
      }
      put('calendario', 'Tu calendario:', evs.slice(0, 10).map(e => `${fecha(e.inicio, e.todoElDia)}: ${e.titulo}${e.lugar ? ` (${e.lugar})` : ''}`))
    }])
    tasks.push(['gmail', async () => {
      const phone = !esGrupo && chatId.endsWith('@s.whatsapp.net') ? chatId.split('@')[0] : null
      const email = phone ? await emailForPhone(phone).catch(() => null) : null
      const q = email ? `(from:${email} OR to:${email}) newer_than:90d`
        : words.length ? `(${words.slice(0, 3).join(' OR ')}) newer_than:30d` : null
      if (!q) return
      const mails = await gmailSearch(q, email ? 3 : 2)
      put('gmail', `Correos relacionados${email ? ' con esta persona' : ''}:`, mails.map(m =>
        `${new Date(m.fecha).toLocaleDateString('es-ES')} · ${m.de} · "${m.asunto}": ${m.resumen}`))
    }])
    if (words.length) {
      tasks.push(['drive', async () => {
        const files = await driveSearch(words)
        put('drive', 'Archivos tuyos en Drive con nombre parecido:', files.map(x => `${x.name} (modificado ${new Date(x.modifiedTime).toLocaleDateString('es-ES')})`))
      }])
    }
  }

  if (f.chats !== false && !esGrupo && words.length) {
    tasks.push(['chats', async () => {
      const query = words.map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).join(' | ')
      const { rows } = await pool.query(
        `SELECT m.text, m.ts, m.from_me, COALESCE(ch.name, ct.name, ct.notify, split_part(m.chat_id, '@', 1)) AS chat
         FROM messages m LEFT JOIN chats ch ON ch.chat_id = m.chat_id LEFT JOIN contacts ct ON ct.jid = m.chat_id
         WHERE m.chat_id <> $1 AND m.ts > now() - interval '60 days' AND m.tsv @@ to_tsquery('spanish', $2)
         ORDER BY m.ts DESC LIMIT 3`, [chatId, query])
      put('chats', 'Se hablo de esto en otros chats tuyos:', rows.map(r =>
        `${new Date(r.ts).toLocaleDateString('es-ES')} en "${r.chat}" (${r.from_me ? 'tu' : 'te dijeron'}): ${r.text.slice(0, 160)}`))
    }])
  }

  if (f.chrome !== false && words.length && process.platform === 'win32') {
    tasks.push(['chrome', async () => {
      const pages = await chromeSearch(words)
      put('chrome', 'Paginas que has visitado estos dias:', pages.map(p => `${p.titulo}${p.sitio ? ` (${p.sitio})` : ''}`))
    }])
  }

  if (f.web !== false && PIDE_DATO.test(incoming || '')) {
    tasks.push(['web', async () => {
      const consulta = await decideSearch(incoming)
      if (!consulta) return
      usado.busqueda = consulta // se ensena en el panel: lo unico que salio del Huawei
      const results = await webSearch(consulta)
      put('web', `Resultados de internet para "${consulta}":`, results.map(r => `${r.titulo}${r.sitio ? ` (${r.sitio})` : ''}: ${r.resumen}`))
    }, 5 * 60_000]) // incluye lo que tarda la IA en decidir
  }

  await Promise.all(tasks.map(([key, fn, ms = 15_000]) => withTimeout(fn(), ms).catch(err => {
    ;(usado.errores ||= []).push(`${key}: ${err.message}`)
  })))

  const order = ['calendario', 'gmail', 'drive', 'chats', 'chrome', 'web']
  return { lines: order.flatMap(k => sections[k] || []), usado }
}
