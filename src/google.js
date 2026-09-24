// Google (Gmail, Calendar, Drive, Contactos) en SOLO LECTURA, con tu propio proyecto de Google Cloud.
// Los permisos (tokens) se guardan en %LOCALAPPDATA%\asistente-whatsapp\ajustes.json.
// Lo que se lee solo se usa dentro del Huawei para dar contexto a los borradores.
import { createHash, randomBytes } from 'node:crypto'
import { config } from './config.js'
import { saveSettings, settings } from './settings.js'

const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly', // solo nombres de archivos, no su contenido
  'https://www.googleapis.com/auth/contacts.readonly', // para saber el email de cada contacto de WhatsApp
]
export const redirectUri = () => `http://127.0.0.1:${config.panelPort}/oauth/google`

// CANDADO 1 - Unicos permisos aceptados. Google devuelve la lista de permisos concedidos: si hubiera
// cualquier otro (enviar, modificar, borrar...), la conexion se rechaza y el permiso se revoca.
const ALLOWED_SCOPES = new Set([...SCOPES, 'https://www.googleapis.com/auth/userinfo.email'])
export function checkScopes(scope) {
  const granted = String(scope || '').split(/\s+/).filter(Boolean)
  const extra = granted.filter(s => !ALLOWED_SCOPES.has(s))
  if (!granted.length || extra.length) {
    throw new Error(`Google concedio permisos que no son de solo lectura (${extra.join(', ') || 'lista vacia'}). Conexion rechazada.`)
  }
  return granted
}

// CANDADO 2 - Con los datos solo se hacen lecturas (GET) y solo a estos servidores de Google
const READ_HOSTS = new Set(['gmail.googleapis.com', 'www.googleapis.com', 'people.googleapis.com', 'openidconnect.googleapis.com'])

const g = () => settings().google
const saveG = patch => saveSettings({ google: { ...g(), ...patch } })
const status = { error: null }

export function googleInfo() {
  const s = g()
  return { configurado: !!(s.clientId && s.clientSecret), conectado: !!s.tokens?.refresh_token, email: s.email, error: status.error }
}

export function setCredentials(clientId, clientSecret) {
  clientId = String(clientId || '').trim()
  clientSecret = String(clientSecret || '').trim()
  if (!clientId.endsWith('.apps.googleusercontent.com')) throw new Error('El ID de cliente debe terminar en .apps.googleusercontent.com')
  if (clientSecret.length < 10) throw new Error('Falta el secreto de cliente')
  saveG({ clientId, clientSecret, tokens: null, email: null, pending: null })
}

/** URL de autorizacion de Google (con PKCE). */
export function authUrl() {
  const s = g()
  if (!s.clientId) throw new Error('Primero guarda el ID y el secreto de cliente')
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(16).toString('hex')
  saveG({ pending: { verifier, state, at: Date.now() } })
  const params = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

async function tokenRequest(params) {
  const s = g()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, ...params }),
    signal: AbortSignal.timeout(15_000),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error_description || j.error || `HTTP ${res.status}`)
  return j
}

/** Vuelta de Google tras aceptar los permisos. */
export async function handleCallback(query) {
  const s = g()
  if (query.get('error')) throw new Error(`Google no dio permiso: ${query.get('error')}`)
  if (!s.pending || query.get('state') !== s.pending.state || Date.now() - s.pending.at > 15 * 60_000) {
    throw new Error('Enlace caducado o no valido. Vuelve a pulsar "Conectar con Google".')
  }
  const tok = await tokenRequest({
    code: query.get('code'), redirect_uri: redirectUri(), grant_type: 'authorization_code', code_verifier: s.pending.verifier,
  })
  try {
    checkScopes(tok.scope)
  } catch (err) {
    await revoke(tok.refresh_token || tok.access_token)
    throw err
  }
  if (!tok.refresh_token) throw new Error('Google no devolvio permiso permanente. Quita el acceso en myaccount.google.com/permissions y vuelve a conectar.')
  const tokens = { ...tok, expires_at: Date.now() + tok.expires_in * 1000 }
  let email = null
  try { email = (await gget('https://openidconnect.googleapis.com/v1/userinfo', tokens.access_token)).email } catch { /* opcional */ }
  saveG({ tokens, email, pending: null })
  status.error = null
  return email
}

async function accessToken() {
  const s = g()
  if (!s.tokens?.refresh_token) throw new Error('Google no conectado')
  checkScopes(s.tokens.scope) // se vuelve a comprobar antes de cada uso
  if (s.tokens.access_token && s.tokens.expires_at > Date.now() + 60_000) return s.tokens.access_token
  const t = await tokenRequest({ refresh_token: s.tokens.refresh_token, grant_type: 'refresh_token' })
  if (t.scope) {
    try {
      checkScopes(t.scope)
    } catch (err) {
      await disconnectGoogle()
      throw err
    }
  }
  saveG({ tokens: { ...s.tokens, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000, scope: t.scope || s.tokens.scope } })
  return t.access_token
}

async function gget(url, token) {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !READ_HOSTS.has(u.hostname)) throw new Error(`servidor no permitido: ${u.hostname}`)
  const res = await fetch(u, { method: 'GET', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error?.message || j.error_description || `HTTP ${res.status}`)
  return j
}

async function api(url) {
  try {
    const r = await gget(url, await accessToken())
    status.error = null
    return r
  } catch (err) {
    status.error = err.message
    throw err
  }
}

/** Anula un permiso en Google (lo mismo que quitarlo en myaccount.google.com/permissions). */
async function revoke(token) {
  if (!token) return
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {})
}

export async function disconnectGoogle() {
  const token = g().tokens?.refresh_token
  saveG({ tokens: null, email: null, pending: null })
  await revoke(token)
}

// ---------- Lecturas ----------

export async function calendarEvents({ days = 7, q } = {}) {
  const now = new Date()
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + days * 864e5).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '10',
  })
  if (q) params.set('q', q)
  const j = await api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`)
  return (j.items || []).map(e => ({
    titulo: e.summary || '(sin titulo)', inicio: e.start?.dateTime || e.start?.date, todoElDia: !e.start?.dateTime, lugar: e.location || null,
  }))
}

export async function gmailSearch(q, max = 3) {
  const list = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q, maxResults: String(max) })}`)
  const out = []
  for (const m of list.messages || []) {
    const d = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`)
    const h = n => d.payload?.headers?.find(x => x.name.toLowerCase() === n)?.value || ''
    out.push({ asunto: h('subject'), de: h('from').replace(/<[^>]+>/, '').trim(), fecha: Number(d.internalDate), resumen: (d.snippet || '').slice(0, 200) })
  }
  return out
}

export async function driveSearch(words, max = 3) {
  const q = words.slice(0, 3).map(w => `name contains '${w.replace(/['\\]/g, '')}'`).join(' or ')
  const j = await api(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q: `(${q}) and trashed = false`, pageSize: String(max), fields: 'files(name,modifiedTime)', orderBy: 'modifiedTime desc',
  })}`)
  return j.files || []
}

/** Telefono → email usando tus Contactos de Google (cacheado 12 h). */
let phoneMap = { at: 0, map: new Map() }
export const normPhone = p => {
  let d = String(p || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.length === 9 && /^[6789]/.test(d)) d = '34' + d
  return d
}
export async function emailForPhone(digits) {
  if (Date.now() - phoneMap.at > 12 * 3600_000) {
    const map = new Map()
    let pageToken = ''
    for (let i = 0; i < 10; i++) {
      const params = new URLSearchParams({ personFields: 'emailAddresses,phoneNumbers', pageSize: '1000' })
      if (pageToken) params.set('pageToken', pageToken)
      const j = await api(`https://people.googleapis.com/v1/people/me/connections?${params}`)
      for (const p of j.connections || []) {
        const email = p.emailAddresses?.[0]?.value
        if (!email) continue
        for (const ph of p.phoneNumbers || []) map.set(normPhone(ph.canonicalForm || ph.value), email)
      }
      pageToken = j.nextPageToken
      if (!pageToken) break
    }
    phoneMap = { at: Date.now(), map }
  }
  return phoneMap.map.get(normPhone(digits)) || null
}
