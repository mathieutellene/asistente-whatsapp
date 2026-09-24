// Prueba automatica SIN WhatsApp ni Ollama (la ejecuta GitHub Actions en cada cambio):
// extraccion, exclusiones, base de datos, vista de pendientes, prompt de borradores y panel.
// OJO: vacia las tablas. Nunca ejecutarla contra la base de datos real.
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { insertMessages, pool, purgeJids, upsertChat, upsertContact } from '../db.js'
import { excludedJids, isExcluded } from '../exclusions.js'
import { extractContent } from '../extract.js'
import { decideSearch, gatherContext, keywords } from '../context.js'
import { generate } from '../drafts.js'
import { chat, checkOllama, ensureModel, iaReady, iaStatus } from '../ollama.js'
import { startPanel } from '../panel/server.js'
import { analyzeChat, getProfile, saveNotes } from '../profiles.js'
import { patchSection } from '../settings.js'
import { buildPrompt, cleanDraft } from '../style.js'
import { parseResults, sanitizeQuery } from '../web.js'

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
await pool.query('TRUNCATE messages, chats, contacts, drafts, lid_map, chat_profiles')
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

// 6. IA con un Ollama simulado (OLLAMA_URL en CI apunta aqui): respuestas por partes,
//    modelo anterior mientras se descarga el nuevo, progreso de descarga y borrado del antiguo
let fakeModels = ['qwen3:4b']
const fake = createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    const line = o => JSON.stringify(o) + '\n'
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: fakeModels.map(name => ({ name, model: name })) }))
    if (req.url === '/api/chat') {
      const b = JSON.parse(body)
      assert.equal(b.stream, true)
      const props = b.format?.properties || {}
      let content
      if (props.relacion) { // analisis de perfil
        content = JSON.stringify({ relacion: 'Amiga de confianza', tono: 'Informal', como_escribes: 'Corto y con emojis', temas: 'Cenas', datos: 'Cena el sabado', evitar: 'Ser formal' })
      } else if (props.buscar) { // ¿buscar en internet?
        const u = b.messages.at(-1).content
        content = JSON.stringify(/farmacia/.test(u) ? { buscar: true, consulta: 'horario farmacia 600 111 222 centro ana@correo.es' } : { buscar: false, consulta: '' })
      } else { // borrador: el razonamiento se cuela, como hace un modelo "thinking"
        const t = b.options?.temperature
        content = 'Okay, I need to answer...</think>' + JSON.stringify({ respuesta: t === 0.6 ? 'sii, allí estaré' : `vale, allí estaré (${t})` })
      }
      const half = Math.floor(content.length / 2)
      res.write(line({ message: { content: content.slice(0, half) } }))
      return setTimeout(() => res.end(line({ message: { content: content.slice(half) }, done: true })), 50)
    }
    if (req.url === '/api/pull') {
      res.write(line({ status: 'pulling', total: 200, completed: 100 }))
      fakeModels.push(JSON.parse(body).model)
      return setTimeout(() => res.end(line({ status: 'success' })), 100)
    }
    if (req.url === '/api/delete' && req.method === 'DELETE') {
      fakeModels = fakeModels.filter(m => m !== JSON.parse(body).model)
      return res.end()
    }
    res.statusCode = 404
    res.end(line({ error: 'no encontrado' }))
  })
})
await new Promise(r => fake.listen(Number(new URL(process.env.OLLAMA_URL).port), '127.0.0.1', r))
await checkOllama()
assert.equal(iaStatus.instalado, false)
assert.equal(iaStatus.usando, 'qwen3:4b', 'mientras se descarga, usa el modelo anterior')
assert.ok(iaReady())
const reply = await chat([{ role: 'user', content: 'hola' }])
assert.equal(reply.model, 'qwen3:4b')
assert.equal(cleanDraft(reply.text, 'Mat'), 'sii, allí estaré')
await ensureModel()
assert.equal(iaStatus.instalado, true)
assert.equal(iaStatus.usando, 'qwen3:4b-instruct')
assert.deepEqual(fakeModels, ['qwen3:4b-instruct'], 'el modelo antiguo se borra')
ok('IA: respuestas por partes, modelo anterior durante la descarga y limpieza')

// 7. Contexto: palabras clave, otros chats, busqueda en internet anonima
assert.deepEqual(keywords('Oye, ¿y el sábado vienes a la cena?').sort(), ['cena', 'sábado', 'vienes'])
assert.equal(sanitizeQuery('horario farmacia 600 111 222 centro ana@correo.es'), 'horario farmacia centro')
const B = '34611000002@s.whatsapp.net'
await upsertContact({ jid: B, name: 'Bea' })
await insertMessages([{ chat_id: B, msg_id: 'b1', from_me: false, sender_jid: B, sender_name: 'Bea', ts: ago(30), type: 'conversation', text: 'La cena del sábado es en casa de Laura' }])
patchSection('fuentes', { web: false })
const ctx = await gatherContext({ chatId: A, esGrupo: false, incoming: 'Oye, ¿y el sábado vienes a la cena?' })
assert.equal(ctx.usado.chats, 1, 'encuentra el tema en otro chat')
assert.ok(ctx.lines.some(l => l.includes('casa de Laura') && l.includes('Bea')))
const ctxGroup = await gatherContext({ chatId: G, esGrupo: true, incoming: 'la cena del sábado?' })
assert.equal(ctxGroup.usado.chats, undefined, 'en grupos no se mira en otros chats')
patchSection('fuentes', { web: true })
assert.equal(await decideSearch('¿sabes a qué hora abre la farmacia del centro?'), 'horario farmacia centro', 'consulta sin telefono ni correo')
assert.equal(await decideSearch('¿qué tal estás?'), null)
const html = '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.farmacias.es%2Fcentro">Farmacia Centro &amp; Horarios</a><a class="result__snippet" href="#">Abierta de <b>9</b> a 21 h.</a></div>'
assert.deepEqual(parseResults(html), [{ titulo: 'Farmacia Centro & Horarios', resumen: 'Abierta de 9 a 21 h.', sitio: 'farmacias.es' }])
ok('contexto: otros chats, grupos aparte, busqueda anonima y lectura de resultados')

// 8. Perfil del chat + notas + borrador con varias opciones
const perfil = await analyzeChat(A).catch(() => null)
assert.equal(perfil, null, 'con menos de 5 mensajes no se analiza')
await insertMessages([1, 2, 3].map(i => ({ chat_id: A, msg_id: `a0${i}`, from_me: i % 2 === 0, sender_jid: i % 2 === 0 ? 'yo@s.whatsapp.net' : A, sender_name: i % 2 === 0 ? 'Yo' : 'Ana', ts: ago(600 + i), type: 'conversation', text: `mensaje antiguo ${i}` })))
assert.equal((await analyzeChat(A)).relacion, 'Amiga de confianza')
await saveNotes(A, 'Tratala de tu, sin emojis')
const withProfile = await buildPrompt(A, 'Mat', { context: false })
assert.match(withProfile.system, /INSTRUCCIONES TUYAS PARA ESTE CHAT \(cumplelas siempre\): Tratala de tu, sin emojis/)
assert.match(withProfile.system, /Amiga de confianza/)
assert.equal((await getProfile(A)).notas, 'Tratala de tu, sin emojis')
patchSection('ia', { opciones: 3 })
patchSection('fuentes', { web: false })
const draftId = await generate(A)
const { rows: [d] } = await pool.query('SELECT * FROM drafts WHERE id = $1', [draftId])
assert.equal(d.text, 'sii, allí estaré')
assert.equal(d.alternativas.length, 3)
assert.deepEqual(d.alternativas.map(a => a.texto), ['sii, allí estaré', 'vale, allí estaré (0.85)', 'vale, allí estaré (1)'])
assert.equal(d.contexto.perfil, 1)
assert.equal(d.contexto.notas, 1)
assert.equal(d.contexto.chats, 1)
await pool.query('DELETE FROM drafts')
fake.close()
ok('perfil del chat, tus notas y borrador con 3 opciones')

// 9. Panel
const server = startPanel(Number(process.env.PANEL_PORT) || 8799)
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
const home = await fetch(base + '/')
assert.equal(home.status, 200)
assert.match(await home.text(), /Asistente WhatsApp/)
const estado = await (await fetch(base + '/api/estado')).json()
assert.equal(estado.memoria.mensajes, 7)
assert.equal(estado.excluidos, 1)
assert.equal(estado.perfiles.hechos, 1)
assert.equal(estado.ia.catalogo.length >= 3, true)
assert.equal(estado.google.conectado, false)
assert.equal((await (await fetch(base + '/api/tablas/messages?q=cena')).json()).total, 2)
assert.equal((await (await fetch(base + '/api/tablas/chat_profiles')).json()).total, 1)
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
const pendientes = await (await fetch(base + '/api/pendientes')).json()
assert.ok(pendientes.some(p => p.chat_id === A))
const post = (path, body, host) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body)
  const r = request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-asistente': '1', ...(host ? { host } : {}) } },
  res => { let s = ''; res.on('data', c => { s += c }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s || '{}') })) })
  r.on('error', reject)
  r.end(data)
})
const perfilApi = await (await fetch(`${base}/api/perfil?chat=${encodeURIComponent(A)}`)).json()
assert.equal(perfilApi.nombre, 'Ana')
assert.equal(perfilApi.perfil.relacion, 'Amiga de confianza')
assert.equal((await post('/api/perfil', { chatId: A, notas: 'nuevas notas' })).status, 200)
assert.equal((await getProfile(A)).notas, 'nuevas notas')
assert.equal((await post('/api/ia', { accion: 'opciones', n: 2 })).status, 200)
assert.equal((await post('/api/ia', { accion: 'opciones', n: 9 })).status, 400)
assert.equal((await post('/api/ia', { accion: 'modelo', modelo: 'kimi-k2' })).status, 400, 'solo modelos del catalogo')
assert.equal((await post('/api/fuentes', { clave: 'web', valor: false })).status, 200)
assert.equal((await post('/api/fuentes', { clave: 'ubicacion', valor: true })).status, 400, 'la ubicacion ya no existe')
assert.equal((await post('/api/google', { accion: 'credenciales', clientId: 'x', clientSecret: 'y' })).status, 400)
assert.equal((await post('/api/google', { accion: 'credenciales', clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secreto-de-prueba' })).status, 200)
const gurl = await post('/api/google', { accion: 'url' })
assert.equal(gurl.status, 200)
assert.match(gurl.body.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?.*gmail\.readonly/)
assert.match(gurl.body.url, /code_challenge_method=S256/)
assert.doesNotMatch(gurl.body.url, /gmail\.(send|modify|compose)|calendar(?!\.readonly)|drive(?!\.metadata\.readonly)/, 'solo permisos de lectura')
assert.equal((await post('/api/google', { accion: 'url' }, 'huawei.tail1234.ts.net')).status, 400, 'Google solo se conecta desde el Huawei')
const cb = await fetch(`${base}/oauth/google?code=x&state=otro`)
assert.equal(cb.status, 400, 'vuelta de Google con state incorrecto')
ok('panel: pagina, estado, tablas, borradores, perfiles, ajustes, Google y protecciones')

server.close()
await pool.end()
console.log('\nTodas las pruebas han pasado.')
process.exit(0)
