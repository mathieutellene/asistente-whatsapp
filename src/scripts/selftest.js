// Prueba automatica SIN WhatsApp ni Ollama (la ejecuta GitHub Actions en cada cambio):
// extraccion, exclusiones, base de datos, vista de pendientes, prompt de borradores y panel.
// OJO: vacia las tablas. Nunca ejecutarla contra la base de datos real.
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { insertMessages, pool, purgeJids, upsertChat, upsertContact } from '../db.js'
import { excludedJids, isExcluded } from '../exclusions.js'
import { extractContent } from '../extract.js'
import { startPanel } from '../panel/server.js'
import { buildPrompt, cleanDraft } from '../style.js'

if (!process.env.CI) {
  console.error('Esta prueba vacia la base de datos: solo se ejecuta en GitHub Actions (CI=true).')
  process.exit(1)
}
const ok = m => console.log('OK', m)

// 1. Extraccion de mensajes
assert.equal(extractContent({ conversation: 'hola' }).text, 'hola')
const quoted = extractContent({ ephemeralMessage: { message: { extendedTextMessage: { text: 'x', contextInfo: { stanzaId: 'Q1', mentionedJid: ['1@s.whatsapp.net'] } } } } })
assert.equal(quoted.quotedId, 'Q1')
assert.deepEqual(quoted.mentions, ['1@s.whatsapp.net'])
assert.equal(extractContent({ reactionMessage: { text: '👍' } }), null)
assert.equal(extractContent({ audioMessage: { ptt: true, seconds: 7 } }).text, '[nota de voz 7s]')
ok('extraccion de mensajes')

// 2. Exclusiones (en CI, EXCLUDE_FILE contiene "+34 600 111 222")
assert.ok(isExcluded('34600111222@s.whatsapp.net'))
assert.ok(!isExcluded('34600999888@s.whatsapp.net'))
ok('lista de excluidos')

// 3. Guardar mensajes
const A = '34611000001@s.whatsapp.net'
const X = '34600111222@s.whatsapp.net'
const G = '120363000000@g.us'
await pool.query('TRUNCATE messages, chats, contacts, drafts, lid_map')
await upsertContact({ jid: A, name: 'Ana' })
await upsertChat({ chat_id: G, is_group: true, name: 'Grupo prueba' })
const ago = m => new Date(Date.now() - m * 60_000)
const rows = [
  { chat_id: A, msg_id: 'a1', from_me: false, sender_jid: A, sender_name: 'Ana', ts: ago(60), type: 'conversation', text: '¿Quedamos mañana para el café?' },
  { chat_id: A, msg_id: 'a2', from_me: true, sender_jid: 'yo@s.whatsapp.net', sender_name: 'Yo', ts: ago(58), type: 'conversation', text: 'vale! a las 10 😊' },
  { chat_id: A, msg_id: 'a3', from_me: false, sender_jid: A, sender_name: 'Ana', ts: ago(5), type: 'conversation', text: 'Oye, ¿y el sábado vienes a la cena?' },
  { chat_id: X, msg_id: 'x1', from_me: false, sender_jid: X, sender_name: 'Excluido', ts: ago(3), type: 'conversation', text: 'secreto' },
  { chat_id: G, msg_id: 'g1', from_me: false, sender_jid: X, sender_name: 'Excluido', ts: ago(2), type: 'conversation', text: 'secreto en grupo', mentions: [X] },
]
assert.equal(await insertMessages(rows), 5)
assert.equal(await insertMessages(rows), 0, 'no debe duplicar')
ok('guardar mensajes sin duplicados')

// 4. Borrado de excluidos (chat individual + sus mensajes en grupos)
const purged = await purgeJids(excludedJids())
assert.ok(purged >= 2)
const { rows: [left] } = await pool.query(`SELECT count(*)::int AS n FROM messages WHERE text LIKE 'secreto%'`)
assert.equal(left.n, 0)
ok(`borrado de excluidos (${purged} registros)`)

// 5. Pendientes y prompt
const { rows: pend } = await pool.query('SELECT * FROM pendientes')
assert.ok(pend.some(p => p.chat_id === A && p.sin_responder === 1))
const prompt = await buildPrompt(A, 'Mat')
assert.match(prompt.system, /Eres Mat/)
assert.match(prompt.user, /sábado/)
assert.equal(prompt.nombre, 'Ana')
assert.equal(cleanDraft('Tú: "vale, allí estaré"', 'Mat'), 'vale, allí estaré')
assert.equal(cleanDraft('<think>mmm</think>\nMat: claro!', 'Mat'), 'claro!')
// Salida real de un modelo "thinking": razonamiento en ingles sin <think> de apertura
assert.equal(cleanDraft("Okay, I understand I need to answer Mat's message. I see the previous...</think>\n\n{\"respuesta\": \"sii, allí estaré 😊\"}", 'Mat'), 'sii, allí estaré 😊')
assert.equal(cleanDraft('{"respuesta": "vale, mañana te lo paso"}', 'Mat'), 'vale, mañana te lo paso')
assert.equal(cleanDraft('```json\n{"respuesta": "perfecto!"}\n```', 'Mat'), 'perfecto!')
assert.equal(cleanDraft('{"respuesta": "dime \\"cuándo\\" y voy"', 'Mat'), 'dime "cuándo" y voy') // JSON cortado
assert.match(prompt.system, /"respuesta"/)
ok('pendientes y prompt del borrador')

// 6. Panel
const server = startPanel(Number(process.env.PANEL_PORT) || 8799)
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
const home = await fetch(base + '/')
assert.equal(home.status, 200)
assert.match(await home.text(), /Asistente WhatsApp/)
const estado = await (await fetch(base + '/api/estado')).json()
assert.equal(estado.memoria.mensajes, 3)
assert.equal(estado.excluidos, 1)
assert.equal((await (await fetch(base + '/api/tablas/messages?q=cena')).json()).total, 1)
assert.equal((await fetch(base + '/api/tablas/pg_shadow')).status, 404, 'solo tablas permitidas')
assert.equal((await fetch(base + '/api/generar', { method: 'POST', body: '{}' })).status, 403, 'POST sin cabecera propia')
const foreignHost = await new Promise(resolve => {
  request({ host: '127.0.0.1', port: server.address().port, path: '/api/estado', headers: { host: 'evil.example.com' } },
    r => resolve(r.statusCode)).end()
})
assert.equal(foreignHost, 403, 'host ajeno (DNS rebinding)')
await pool.query(`INSERT INTO drafts (chat_id, text) VALUES ($1, 'claro!')`, [A])
const drafts = await (await fetch(base + '/api/borradores')).json()
assert.equal(drafts.length, 1)
assert.ok(drafts[0].contexto.length >= 1)
const upd = await fetch(`${base}/api/borradores/${drafts[0].id}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-asistente': '1' },
  body: JSON.stringify({ estado: 'usado', texto: 'claro que sí!' }),
})
assert.equal(upd.status, 200)
assert.equal((await (await fetch(base + '/api/borradores')).json()).length, 0)
assert.equal((await (await fetch(base + '/api/pendientes')).json())[0].chat_id, A)
ok('panel: pagina, estado, tablas, borradores y protecciones')

server.close()
await pool.end()
console.log('\nTodas las pruebas han pasado.')
process.exit(0)
