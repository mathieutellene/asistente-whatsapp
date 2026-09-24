// Panel de control. Escucha SOLO en 127.0.0.1: desde el movil se entra con Tailscale ("tailscale serve"),
// que lo publica unicamente dentro de tu red privada. Las tablas se ven en modo solo lectura.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { config } from '../config.js'
import { pool } from '../db.js'
import { requestDraft, draftStatus } from '../drafts.js'
import { excludedNumbers } from '../exclusions.js'
import { authUrl, disconnectGoogle, googleInfo, handleCallback, setCredentials } from '../google.js'
import { deleteModel, iaReady, iaStatus, MODELOS, pullModel, wantedModel } from '../ollama.js'
import { getProfile, PROFILE_LABELS, profileStatus, requestProfile, saveNotes } from '../profiles.js'
import { patchSection, settings } from '../settings.js'
import {
  configureTelegram, setTelegramMode, telegramInfo, testTelegram, unlinkTelegram,
} from '../telegram.js'
import { tailscaleStatus } from '../tailscale.js'
import { waStatus } from '../whatsapp.js'

const HTML = readFileSync(new URL('./index.html', import.meta.url), 'utf8')

const CHAT_NAME = `COALESCE(ch.name, cc.name, cc.notify, split_part(%s, '@', 1))`
const chatName = col => CHAT_NAME.replace('%s', col)

// Tablas visibles (solo lectura). La columna tsv (indice de busqueda) no se muestra.
const TABLES = {
  messages: { cols: 'ts, chat_id, from_me, sender_name, type, text, quoted_id, mentions, msg_id, sender_jid', order: 'ts DESC', search: ['text', 'sender_name', 'chat_id'] },
  chats: { cols: 'chat_id, name, is_group, archived, muted_until, updated_at', order: 'updated_at DESC', search: ['name', 'chat_id'] },
  contacts: { cols: 'jid, name, notify, updated_at', order: 'updated_at DESC', search: ['name', 'notify', 'jid'] },
  drafts: { cols: 'id, created_at, status, chat_id, text, my_reply, model, gen_ms, alternativas, contexto', order: 'created_at DESC', search: ['text', 'chat_id', 'status'] },
  chat_profiles: { cols: 'chat_id, notas, perfil, msgs_count, updated_at', order: 'updated_at DESC NULLS LAST', search: ['chat_id', 'notas', 'perfil'] },
  lid_map: { cols: 'lid, pn', order: 'lid', search: ['lid', 'pn'] },
}

const routes = []
const route = (method, pattern, handler) => routes.push({ method, pattern, handler })

route('GET', /^\/api\/estado$/, async () => {
  const [{ rows: [mem] }, { rows: [pend] }, { rows: [bor] }, ts] = await Promise.all([
    pool.query(`SELECT count(*)::int AS mensajes, count(DISTINCT chat_id)::int AS chats,
                       min(ts) AS desde, max(ts) AS ultimo FROM messages`),
    pool.query(`SELECT count(*)::int AS n FROM pendientes WHERE ultimo_mensaje > now() - interval '7 days'`),
    pool.query(`SELECT count(*)::int AS n FROM drafts WHERE status = 'pendiente'`),
    tailscaleStatus(),
  ])
  const { rows: [prof] } = await pool.query('SELECT count(*) FILTER (WHERE perfil IS NOT NULL)::int AS hechos FROM chat_profiles')
  const s = settings()
  return {
    whatsapp: waStatus,
    memoria: mem,
    pendientes: pend.n,
    borradores: bor.n,
    ia: { ...iaStatus, ...draftStatus, opciones: s.ia.opciones, catalogo: MODELOS },
    perfiles: { ...profileStatus, hechos: prof.hechos },
    telegram: telegramInfo(),
    tailscale: ts,
    excluidos: excludedNumbers.size,
    google: googleInfo(),
    fuentes: s.fuentes,
  }
})

// ---------- Perfil de un chat (analisis + tus notas) ----------
route('GET', /^\/api\/perfil$/, async q => {
  const chatId = q.get('chat') || ''
  const p = await getProfile(chatId)
  const { rows: [info] } = await pool.query(
    `SELECT ${chatName('x.id')} AS nombre FROM (SELECT $1::text AS id) x
     LEFT JOIN chats ch ON ch.chat_id = x.id LEFT JOIN contacts cc ON cc.jid = x.id`, [chatId])
  return { chatId, nombre: info.nombre, perfil: p?.perfil || null, notas: p?.notas || '', updated_at: p?.updated_at || null, etiquetas: PROFILE_LABELS, analizando: profileStatus.analizando === chatId }
})

route('POST', /^\/api\/perfil$/, async (_q, body) => {
  if (typeof body.chatId !== 'string' || !body.chatId.includes('@')) throw httpError(400, 'chat no valido')
  if (body.accion === 'analizar') { requestProfile(body.chatId); return { ok: true } }
  if (typeof body.notas !== 'string' || body.notas.length > 1000) throw httpError(400, 'notas no validas')
  await saveNotes(body.chatId, body.notas.trim())
  return { ok: true }
})

// ---------- IA: modelo, opciones por borrador, comparar ----------
route('POST', /^\/api\/ia$/, async (_q, body) => {
  const known = id => MODELOS.some(m => m.id === id)
  switch (body.accion) {
    case 'modelo':
      if (!known(body.modelo)) throw httpError(400, 'modelo no valido')
      patchSection('ia', { modelo: body.modelo })
      iaStatus.modelo = wantedModel()
      pullModel(body.modelo).catch(() => {}) // si ya esta instalado, termina enseguida
      return { ok: true }
    case 'descargar':
      if (!known(body.modelo)) throw httpError(400, 'modelo no valido')
      pullModel(body.modelo).catch(() => {})
      return { ok: true }
    case 'borrar':
      if (!known(body.modelo) || body.modelo === wantedModel()) throw httpError(400, 'no se puede borrar el modelo en uso')
      await deleteModel(body.modelo)
      return { ok: true }
    case 'opciones': {
      const n = Number(body.n)
      if (![1, 2, 3].includes(n)) throw httpError(400, 'opciones no validas')
      patchSection('ia', { opciones: n })
      return { ok: true }
    }
    case 'comparar': {
      const installed = MODELOS.map(m => m.id).filter(id => iaStatus.instalados.includes(id.includes(':') ? id : `${id}:latest`))
      if (installed.length < 2) throw httpError(400, 'Descarga al menos 2 modelos para comparar')
      const { rows: [p] } = await pool.query(`SELECT chat_id FROM pendientes WHERE NOT es_grupo ORDER BY ultimo_mensaje DESC LIMIT 1`)
      if (!p) throw httpError(400, 'No hay ningun chat pendiente con el que comparar')
      requestDraft(p.chat_id, { models: installed })
      return { ok: true, modelos: installed.length }
    }
  }
  throw httpError(400, 'accion no valida')
})

// ---------- Fuentes de contexto ----------
route('POST', /^\/api\/fuentes$/, async (_q, body) => {
  if (!['chats', 'google', 'chrome', 'web'].includes(body.clave) || typeof body.valor !== 'boolean') throw httpError(400, 'ajuste no valido')
  patchSection('fuentes', { [body.clave]: body.valor })
  return { ok: true }
})

// ---------- Google (solo lectura) ----------
route('POST', /^\/api\/google$/, async (_q, body, _m, req) => {
  if (body.accion === 'credenciales') {
    try { setCredentials(body.clientId, body.clientSecret) } catch (err) { throw httpError(400, err.message) }
    return googleInfo()
  }
  if (body.accion === 'desconectar') { await disconnectGoogle(); return googleInfo() }
  if (body.accion === 'url') {
    // La vuelta de Google va a 127.0.0.1: la autorizacion solo se puede hacer desde el Huawei
    if (!isLocal(req.headers.host)) throw httpError(400, 'Conecta Google desde el propio Huawei (abre panel.cmd alli).')
    return { url: authUrl() }
  }
  throw httpError(400, 'accion no valida')
})

const isLocal = (host = '') => /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)

const page = (title, msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><body style="font:16px -apple-system,Segoe UI,sans-serif;max-width:520px;margin:60px auto;padding:0 16px">
<h2>${title}</h2><p>${msg}</p><p><a href="/#ajustes">Volver al panel</a></p></body>`
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

route('GET', /^\/api\/mensajes$/, async q => {
  const limit = Math.min(Number(q.get('limit')) || 30, 100)
  const { rows } = await pool.query(
    `SELECT m.chat_id, m.msg_id, m.ts, m.text, COALESCE(ct.name, m.sender_name, ct.notify) AS de,
            ${chatName('m.chat_id')} AS chat, COALESCE(ch.is_group, m.chat_id LIKE '%@g.us') AS es_grupo
     FROM messages m
     LEFT JOIN contacts ct ON ct.jid = m.sender_jid
     LEFT JOIN chats ch ON ch.chat_id = m.chat_id
     LEFT JOIN contacts cc ON cc.jid = m.chat_id
     WHERE NOT m.from_me ORDER BY m.ts DESC LIMIT $1`, [limit])
  return rows
})

route('GET', /^\/api\/borradores$/, async q => {
  const pendientes = q.get('estado') !== 'historial'
  const { rows } = await pool.query(
    `SELECT d.id, d.chat_id, d.text, d.status, d.created_at, d.gen_ms, d.my_reply, d.alternativas, d.contexto AS fuentes_usadas, d.model,
            ${chatName('d.chat_id')} AS chat, COALESCE(ch.is_group, d.chat_id LIKE '%@g.us') AS es_grupo,
            (SELECT json_agg(x ORDER BY x.ts) FROM (
               SELECT m.ts, m.from_me, m.text, COALESCE(ct.name, m.sender_name, ct.notify) AS de
               FROM messages m LEFT JOIN contacts ct ON ct.jid = m.sender_jid
               WHERE m.chat_id = d.chat_id AND m.ts <= d.created_at ORDER BY m.ts DESC LIMIT 4) x) AS contexto
     FROM drafts d
     LEFT JOIN chats ch ON ch.chat_id = d.chat_id
     LEFT JOIN contacts cc ON cc.jid = d.chat_id
     WHERE ${pendientes ? `d.status = 'pendiente'` : `d.status <> 'pendiente'`}
     ORDER BY d.created_at DESC LIMIT 50`)
  return rows
})

route('POST', /^\/api\/borradores\/(\d+)$/, async (_q, body, [id]) => {
  if (body.estado && !['usado', 'descartado', 'pendiente'].includes(body.estado)) throw httpError(400, 'estado no valido')
  if (body.texto !== undefined && (typeof body.texto !== 'string' || body.texto.length > 4000)) throw httpError(400, 'texto no valido')
  await pool.query(
    `UPDATE drafts SET status = COALESCE($2, status), text = COALESCE($3, text), updated_at = now() WHERE id = $1`,
    [Number(id), body.estado ?? null, body.texto ?? null])
  return { ok: true }
})

route('GET', /^\/api\/pendientes$/, async () => {
  const { rows } = await pool.query(
    `SELECT p.chat_id, p.nombre, p.es_grupo, p.sin_responder, p.ultimo_mensaje, p.de, left(p.texto, 140) AS texto,
            EXISTS (SELECT 1 FROM drafts d WHERE d.chat_id = p.chat_id AND d.status = 'pendiente') AS tiene_borrador
     FROM pendientes p WHERE p.ultimo_mensaje > now() - interval '7 days'
     ORDER BY p.ultimo_mensaje DESC LIMIT 100`)
  return rows
})

route('POST', /^\/api\/generar$/, async (_q, body) => {
  if (typeof body.chatId !== 'string' || !/^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid)$/.test(body.chatId)) throw httpError(400, 'chat no valido')
  requestDraft(body.chatId)
  return { ok: true, cola: draftStatus.cola, iaLista: iaReady() }
})

route('GET', /^\/api\/tablas$/, async () => {
  const out = []
  for (const name of Object.keys(TABLES)) {
    const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n FROM ${name}`)
    out.push({ tabla: name, filas: r.n })
  }
  return out
})

route('GET', /^\/api\/tablas\/(\w+)$/, async (q, _b, [name]) => {
  const t = TABLES[name]
  if (!t) throw httpError(404, 'tabla no encontrada')
  const search = (q.get('q') || '').slice(0, 100)
  const offset = Math.max(0, Number(q.get('offset')) || 0)
  const where = search ? `WHERE ${t.search.map(c => `${c}::text ILIKE $1`).join(' OR ')}` : ''
  const params = search ? [`%${search}%`] : []
  const [{ rows }, { rows: [c] }] = await Promise.all([
    pool.query(`SELECT ${t.cols} FROM ${name} ${where} ORDER BY ${t.order} LIMIT 50 OFFSET ${offset}`, params),
    pool.query(`SELECT count(*)::int AS n FROM ${name} ${where}`, params),
  ])
  return { columnas: t.cols.split(',').map(s => s.trim()), filas: rows, total: c.n, offset }
})

route('POST', /^\/api\/telegram$/, async (_q, body) => {
  if (body.accion === 'token') return configureTelegram(body.token)
  if (body.accion === 'modo') { setTelegramMode(body.modo); return telegramInfo() }
  if (body.accion === 'probar') { await testTelegram(); return telegramInfo() }
  if (body.accion === 'desvincular') { unlinkTelegram(); return telegramInfo() }
  throw httpError(400, 'accion no valida')
})

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => {
      data += chunk
      if (data.length > 64_000) reject(httpError(413, 'demasiado grande'))
    })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { reject(httpError(400, 'JSON no valido')) }
    })
  })
}

/** Solo se aceptan peticiones dirigidas a este ordenador o a su nombre de Tailscale (evita DNS rebinding). */
function allowedHost(host = '') {
  const h = host.replace(/:\d+$/, '').toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.ts.net')
}

export async function handle(req, res) {
  try {
    if (!allowedHost(req.headers.host)) return send(res, 403, { error: 'host no permitido' })
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, HTML, 'text/html; charset=utf-8')
    }
    if (req.method === 'GET' && url.pathname === '/oauth/google') {
      try {
        const email = await handleCallback(url.searchParams)
        return send(res, 200, page('Google conectado ✅', `Cuenta: <b>${escHtml(email || 'desconocida')}</b>. Solo lectura: Gmail, Calendar, nombres de Drive y Contactos.`), 'text/html; charset=utf-8')
      } catch (err) {
        return send(res, 400, page('No se pudo conectar Google', escHtml(err.message)), 'text/html; charset=utf-8')
      }
    }
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      return send(res, 200, { name: 'Asistente WhatsApp', short_name: 'Asistente', start_url: '/', display: 'standalone', background_color: '#0f1115', theme_color: '#0f1115' }, 'application/manifest+json')
    }
    // Las acciones solo se aceptan desde el propio panel (cabecera propia: otra web no puede ponerla)
    if (req.method === 'POST' && req.headers['x-asistente'] !== '1') return send(res, 403, { error: 'origen no permitido' })
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.pattern)
      if (!m) continue
      const body = req.method === 'POST' ? await readBody(req) : {}
      return send(res, 200, await r.handler(url.searchParams, body, m.slice(1), req))
    }
    send(res, 404, { error: 'no encontrado' })
  } catch (err) {
    send(res, err.status || 500, { error: err.message })
  }
}

export function startPanel(port = config.panelPort) {
  const server = createServer(handle)
  server.on('error', err => console.error(`No se pudo abrir el panel en el puerto ${port}: ${err.message}`))
  server.listen(port, '127.0.0.1', () => console.log(`Panel: http://localhost:${port}`))
  return server
}
