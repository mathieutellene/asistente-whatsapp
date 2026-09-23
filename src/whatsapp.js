// Conexión a WhatsApp como "dispositivo vinculado" (igual que WhatsApp Web).
// SOLO LECTURA: este archivo nunca envía mensajes, ni marca como leído, ni te pone "en línea".

import * as baileys from 'baileys'
import makeWASocket, { Browsers, DisconnectReason, jidNormalizedUser, useMultiFileAuthState } from 'baileys'
import { rm } from 'node:fs/promises'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { config } from './config.js'
import * as db from './db.js'
import { bus } from './events.js'
import { isExcluded } from './exclusions.js'
import { extractContent, toNum } from './extract.js'

const logger = pino({ level: config.logLevel })
const lidCache = new Map()
let sock
let queue = Promise.resolve()
let total = 0
let retries = 0

/** Estado para el panel. */
export const waStatus = { estado: 'iniciando', usuario: null, conectadoDesde: null, historicoRecibido: 0 }

/** Tus propios IDs (numero y @lid), para saber si te mencionan en un grupo. */
export const getMe = () => ({ pn: norm(sock?.user?.id), lid: norm(sock?.user?.lid) })

const isGroup = jid => !!jid?.endsWith('@g.us')
const isIgnored = jid => !jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')
const cutoffMs = () => Date.now() - config.historyMonths * 30.44 * 24 * 3600 * 1000
const norm = jid => (jid ? jidNormalizedUser(jid) : null)
const toDate = secsOrMs => new Date(secsOrMs > 1e12 ? secsOrMs : secsOrMs * 1000)

async function remember(lid, pn) {
  if (!lid?.endsWith('@lid') || !pn || pn.endsWith('@lid') || lidCache.get(lid) === pn) return
  lidCache.set(lid, pn)
  try {
    // Si resulta ser un numero excluido, se borra lo que hubiera entrado con su ID anonimo
    if (isExcluded(pn)) await db.purgeJids([pn, lid])
    else await db.mergeLid(lid, pn)
  } catch (err) {
    logger.warn({ err }, 'no se pudo unificar lid')
  }
}

/** Devuelve el ID "canónico" (número de teléfono) aunque WhatsApp mande un @lid. */
async function canon(jid, alt) {
  const j = norm(jid)
  if (!j || !j.endsWith('@lid')) return j
  if (alt && !alt.endsWith('@lid')) {
    const pn = norm(alt)
    await remember(j, pn)
    return pn
  }
  if (lidCache.has(j)) return lidCache.get(j)
  let pn = await db.getPnForLid(j)
  if (pn) {
    lidCache.set(j, pn)
    return pn
  }
  try {
    pn = norm(await sock?.signalRepository?.lidMapping?.getPNForLID(j))
  } catch { /* sin mapeo todavía */ }
  if (pn && !pn.endsWith('@lid')) {
    await remember(j, pn)
    return pn
  }
  return j
}

async function storeMessages(list, live = false) {
  const cutoff = cutoffMs()
  const me = norm(sock?.user?.id)
  const rows = []
  const names = new Map()
  for (const msg of list || []) {
    try {
      const remote = msg.key?.remoteJid
      if (isIgnored(remote) || !msg.message) continue
      const tsMs = toNum(msg.messageTimestamp) * 1000
      if (!tsMs || tsMs < cutoff) continue
      const content = extractContent(msg.message)
      if (!content) continue
      const group = isGroup(remote)
      const chatId = group ? norm(remote) : await canon(remote, msg.key.remoteJidAlt)
      const fromMe = !!msg.key.fromMe
      const senderJid = fromMe ? me
        : group ? await canon(msg.key.participant, msg.key.participantAlt)
        : chatId
      // Numeros excluidos: se descartan aqui, en memoria, antes de escribir nada en disco
      if (isExcluded(chatId) || isExcluded(senderJid)) continue
      const mentions = content.mentions?.filter(j => !isExcluded(norm(j)) && !isExcluded(lidCache.get(norm(j))))
      if (!fromMe && msg.pushName && senderJid) names.set(senderJid, msg.pushName)
      rows.push({
        chat_id: chatId,
        msg_id: msg.key.id,
        from_me: fromMe,
        sender_jid: senderJid,
        sender_name: fromMe ? 'Yo' : msg.pushName || null,
        ts: new Date(tsMs),
        type: content.type,
        text: content.text,
        quoted_id: content.quotedId,
        mentions: mentions?.length ? mentions : null,
      })
    } catch (err) {
      logger.warn({ err }, 'mensaje ignorado')
    }
  }
  for (const [jid, notify] of names) await db.upsertContact({ jid, notify })
  if (!rows.length) return 0
  const n = await db.insertMessages(rows)
  total += n
  bus.emit('mensajes', { rows, live })
  return n
}

async function storeChats(list) {
  for (const c of list || []) {
    if (isIgnored(c.id)) continue
    const id = isGroup(c.id) ? norm(c.id) : await canon(c.id, c.pnJid)
    if (isExcluded(id)) continue
    const mute = c.muteEndTime === undefined ? undefined : toNum(c.muteEndTime)
    await db.upsertChat({
      chat_id: id,
      is_group: isGroup(id),
      name: c.name ?? c.subject ?? undefined,
      archived: c.archived === undefined || c.archived === null ? undefined : !!c.archived,
      muted_until: mute === undefined ? undefined
        : mute < 0 ? new Date('9999-12-31')
        : mute > 0 ? toDate(mute) : null,
    })
  }
}

async function storeContacts(list) {
  for (const c of list || []) {
    if (isIgnored(c.id)) continue
    if (c.id?.endsWith('@lid') && c.phoneNumber) await remember(norm(c.id), norm(c.phoneNumber))
    if (c.lid && !c.id?.endsWith('@lid')) await remember(norm(c.lid), norm(c.id))
    const jid = await canon(c.id, c.phoneNumber)
    if (!jid || isGroup(jid) || isExcluded(jid)) continue
    await db.upsertContact({ jid, name: c.name ?? undefined, notify: c.notify ?? c.verifiedName ?? undefined })
  }
}

async function storeGroups(list) {
  for (const g of list || []) {
    if (g?.id && g.subject) await db.upsertChat({ chat_id: norm(g.id), is_group: true, name: g.subject })
  }
}

async function onConnection({ connection, lastDisconnect, qr }) {
  if (qr) {
    waStatus.estado = 'esperando QR'
    console.log('\nEscanea este QR con el movil: WhatsApp > Ajustes > Dispositivos vinculados > Vincular un dispositivo\n')
    qrcode.generate(qr, { small: true })
  }
  if (connection === 'open') {
    retries = 0
    Object.assign(waStatus, { estado: 'conectado', usuario: sock.user?.name || null, conectadoDesde: new Date() })
    console.log(`Conectado a WhatsApp como ${sock.user?.name || sock.user?.id}. Recibiendo mensajes...`)
    bus.emit('conectado')
    try {
      await storeGroups(Object.values(await sock.groupFetchAllParticipating()))
    } catch (err) {
      logger.warn({ err }, 'no se pudieron leer los grupos')
    }
  }
  if (connection === 'close') {
    waStatus.estado = 'reconectando'
    const code = lastDisconnect?.error?.output?.statusCode
    if (code === DisconnectReason.loggedOut) {
      console.error('\nWhatsApp ha desvinculado este equipo (o pasaron mas de 14 dias apagado).')
      console.error('Borro la sesion antigua y genero un QR nuevo para volver a vincular...')
      await rm(config.authDir, { recursive: true, force: true })
      setTimeout(() => startWhatsApp().catch(err => logger.error({ err }, 'fallo al reiniciar')), 2000)
      return
    }
    // Espera cada vez mas (3 s, 6 s, 12 s... hasta 2 min) para no insistir contra WhatsApp
    const wait = Math.min(120_000, 3000 * 2 ** retries++)
    console.log(`Conexion cerrada (codigo ${code ?? '?'}). Reconectando en ${Math.round(wait / 1000)} s...`)
    setTimeout(() => startWhatsApp().catch(err => logger.error({ err }, 'fallo al reconectar')), wait)
  }
}

async function handle(events, saveCreds) {
  if (events['connection.update']) await onConnection(events['connection.update'])
  if (events['creds.update']) await saveCreds()

  if (events['messaging-history.set']) {
    const { chats, contacts, messages, progress } = events['messaging-history.set']
    await storeContacts(contacts)
    await storeChats(chats)
    const n = await storeMessages(messages)
    waStatus.historicoRecibido += n
    console.log(`Historico: +${n} mensajes${progress != null ? ` (progreso ${progress}%)` : ''} | total guardado en esta sesion: ${total}`)
  }
  if (events['messages.upsert']) {
    const live = events['messages.upsert'].type === 'notify'
    const n = await storeMessages(events['messages.upsert'].messages, live)
    if (n && live) console.log(`Nuevo(s) mensaje(s): ${n}`)
  }
  if (events['chats.upsert']) await storeChats(events['chats.upsert'])
  if (events['chats.update']) await storeChats(events['chats.update'])
  if (events['contacts.upsert']) await storeContacts(events['contacts.upsert'])
  if (events['contacts.update']) await storeContacts(events['contacts.update'])
  if (events['groups.upsert']) await storeGroups(events['groups.upsert'])
  if (events['groups.update']) await storeGroups(events['groups.update'])

  if (events['lid-mapping.update']) {
    const p = events['lid-mapping.update']
    const list = Array.isArray(p) ? p : p?.mappings || [p]
    for (const m of list) if (m?.lid && m?.pn) await remember(norm(m.lid), norm(m.pn))
  }
}

export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  const options = {
    auth: state,
    logger,
    // Como navegador Chrome: desde 2026 WhatsApp corta con 428 a los clientes que dicen ser
    // "Desktop" antes de mandar el QR (Baileys issue #2677).
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: true,
    markOnlineOnConnect: false,         // no apareces "en linea" y el movil sigue notificando
    getMessage: async () => undefined,
  }
  // Version actual de WhatsApp Web (fetchLatestBaileysVersion puede devolver una antigua: issue #2691)
  for (const fetchVersion of [baileys.fetchLatestWaWebVersion, baileys.fetchLatestBaileysVersion]) {
    try {
      const latest = await fetchVersion?.()
      if (latest?.version) {
        options.version = latest.version
        break
      }
    } catch { /* probamos la siguiente fuente; si no, la version por defecto de la libreria */ }
  }
  if (retries === 0) console.log(`Conectando a WhatsApp (version web ${options.version?.join('.') ?? 'por defecto'})...`)

  sock = makeWASocket(options)
  // Procesa los eventos de uno en uno para no pisar escrituras en la base de datos.
  sock.ev.process(events => {
    queue = queue.then(() => handle(events, saveCreds)).catch(err => logger.error({ err }, 'error procesando eventos'))
  })
}
