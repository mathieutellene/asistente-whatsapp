// Avisos por Telegram (opcional). El bot SOLO envia avisos a tu chat vinculado; ignora a cualquier otra persona.
// Modo "aviso" (por defecto): sin nombres ni contenido. Modo "completo": incluye el borrador
// (ese texto queda entonces en los servidores de Telegram).
import { randomInt } from 'node:crypto'
import { pool } from './db.js'
import { saveSettings, settings } from './settings.js'
import { tailscaleStatus } from './tailscale.js'

export const tgStatus = { estado: 'sin configurar', bot: null, error: null }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tg = () => settings().telegram
const saveTg = patch => saveSettings({ telegram: { ...tg(), ...patch } })

async function call(method, params = {}, token = tg().token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(45_000),
  })
  const j = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))
  if (!j.ok) throw new Error(j.description || 'error de Telegram')
  return j.result
}

/** Guarda el token del bot (de @BotFather) y genera un codigo de vinculacion. */
export async function configureTelegram(token) {
  token = String(token || '').trim()
  if (!/^\d+:[\w-]{30,}$/.test(token)) throw new Error('Ese token no tiene el formato de @BotFather (numeros:letras).')
  const bot = await call('getMe', {}, token)
  saveTg({ token, chatId: null, codigo: String(randomInt(100000, 1000000)) })
  Object.assign(tgStatus, { bot: bot.username, estado: 'esperando vinculacion', error: null })
  return telegramInfo()
}

export function telegramInfo() {
  const t = tg()
  return {
    ...tgStatus,
    modo: t.modo,
    enlace: t.token && !t.chatId && tgStatus.bot ? `https://t.me/${tgStatus.bot}?start=${t.codigo}` : null,
  }
}

export function setTelegramMode(modo) {
  if (!['aviso', 'completo'].includes(modo)) throw new Error('modo no valido')
  saveTg({ modo })
}

export function unlinkTelegram() {
  saveTg({ token: '', chatId: null, codigo: null })
  Object.assign(tgStatus, { estado: 'sin configurar', bot: null, error: null })
}

async function panelLink() {
  const ts = await tailscaleStatus()
  return ts.url ? `\n\nPanel: ${ts.url}#borradores` : ''
}

export async function testTelegram() {
  const t = tg()
  if (!t.chatId) throw new Error('Telegram aun no esta vinculado')
  await call('sendMessage', { chat_id: t.chatId, text: `✅ Prueba del asistente: los avisos funcionan.${await panelLink()}` })
}

// --- Avisos de borradores ---
let lastSent = 0
let flushTimer = null

async function flushAviso() {
  flushTimer = null
  const t = tg()
  if (!t.chatId) return
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM drafts WHERE status = 'pendiente'`)
  if (!n) return
  lastSent = Date.now()
  await call('sendMessage', {
    chat_id: t.chatId,
    text: `📝 Tienes ${n} borrador${n === 1 ? '' : 'es'} esperando en tu asistente.${await panelLink()}`,
    disable_web_page_preview: true,
  })
}

export async function notifyDraft({ chatId, nombre, text }) {
  const t = tg()
  if (!t.token || !t.chatId) return
  if (t.modo === 'completo') {
    const digits = chatId.endsWith('@s.whatsapp.net') ? chatId.split('@')[0] : null
    const wa = digits ? `\n\nAbrir en WhatsApp: https://wa.me/${digits}?text=${encodeURIComponent(text)}` : ''
    await call('sendMessage', {
      chat_id: t.chatId,
      text: `📝 Borrador para ${nombre}:\n\n${text}${wa}${await panelLink()}`,
      disable_web_page_preview: true,
    })
    return
  }
  // Modo aviso: como mucho un mensaje cada 5 minutos, sin nombres ni contenido
  if (!flushTimer) flushTimer = setTimeout(() => flushAviso().catch(() => {}), Math.max(5000, lastSent + 300_000 - Date.now()))
}

// --- Vinculacion: escucha SOLO el "/start CODIGO" de tu propio Telegram ---
export async function startTelegram() {
  let offset = 0
  for (;;) {
    const t = tg()
    if (!t.token) {
      tgStatus.estado = 'sin configurar'
      await sleep(10_000)
      continue
    }
    try {
      if (!tgStatus.bot) tgStatus.bot = (await call('getMe')).username
      tgStatus.estado = t.chatId ? 'vinculado' : 'esperando vinculacion'
      const updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] })
      for (const u of updates) {
        offset = u.update_id + 1
        const m = u.message
        const cur = tg()
        if (!m?.text || m.chat?.type !== 'private') continue
        const text = m.text.trim()
        if (!cur.chatId && cur.codigo && (text === `/start ${cur.codigo}` || text === cur.codigo)) {
          saveTg({ chatId: m.chat.id, codigo: null })
          tgStatus.estado = 'vinculado'
          await call('sendMessage', { chat_id: m.chat.id, text: '✅ Vinculado. Te avisare aqui cuando haya borradores nuevos. Este bot nunca envia nada a tus contactos.' })
        } else if (cur.chatId === m.chat.id) {
          await call('sendMessage', { chat_id: m.chat.id, text: `Solo envio avisos. Tus borradores estan en el panel.${await panelLink()}` })
        } // cualquier otra persona: se ignora
      }
      tgStatus.error = null
    } catch (err) {
      tgStatus.error = err.message
      await sleep(15_000)
    }
  }
}
