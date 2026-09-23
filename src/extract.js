// Convierte un mensaje de WhatsApp en { type, text, quotedId, mentions } o null si no aporta nada
// (reacciones, avisos del sistema, borrados...).

const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'deviceSentMessage',
]
const IGNORE = new Set(['messageContextInfo', 'senderKeyDistributionMessage'])

function unwrap(message) {
  let m = message
  for (let i = 0; i < 5 && m; i++) {
    const w = WRAPPERS.find(k => m[k]?.message)
    if (!w) break
    m = m[w].message
  }
  return m
}

const label = (tag, caption) => (caption ? `[${tag}] ${caption}` : `[${tag}]`)

const HANDLERS = {
  conversation: (_, m) => m.conversation,
  extendedTextMessage: b => b.text,
  imageMessage: b => label('foto', b.caption),
  videoMessage: b => label(b.gifPlayback ? 'gif' : 'video', b.caption),
  audioMessage: b => `[${b.ptt ? 'nota de voz' : 'audio'}${b.seconds ? ` ${b.seconds}s` : ''}]`,
  documentMessage: b => label(`documento ${b.fileName || b.title || ''}`.trim(), b.caption),
  stickerMessage: () => '[sticker]',
  locationMessage: b => `[ubicacion${b.name ? ': ' + b.name : ''}]`,
  liveLocationMessage: () => '[ubicacion en tiempo real]',
  contactMessage: b => `[contacto: ${b.displayName || ''}]`,
  contactsArrayMessage: () => '[contactos]',
  pollCreationMessage: b => `[encuesta: ${b.name || ''}] ${(b.options || []).map(o => o.optionName).join(' / ')}`,
  eventMessage: b => `[evento: ${b.name || ''}]`,
}
HANDLERS.pollCreationMessageV2 = HANDLERS.pollCreationMessage
HANDLERS.pollCreationMessageV3 = HANDLERS.pollCreationMessage

export function extractContent(message) {
  const m = unwrap(message)
  if (!m) return null
  const type = Object.keys(m).find(k => !IGNORE.has(k) && m[k] && HANDLERS[k])
  if (!type) return null
  const body = m[type]
  const text = HANDLERS[type](body, m)
  if (typeof text !== 'string' || !text.trim()) return null
  const ctx = (typeof body === 'object' && body?.contextInfo) || null
  return {
    type: type.replace(/Message$/, ''),
    text: text.trim(),
    quotedId: ctx?.stanzaId || null,
    mentions: ctx?.mentionedJid?.length ? ctx.mentionedJid : null,
  }
}

/** Los timestamps de WhatsApp llegan como number, bigint o Long. */
export function toNum(v) {
  if (v == null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v.toNumber === 'function') return v.toNumber()
  return Number(v) || 0
}
