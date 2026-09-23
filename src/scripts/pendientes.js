// Uso: npm run pendientes [dias]   (por defecto, ultimos 14 dias)
import { pool } from '../db.js'

const dias = Number(process.argv[2] || 14)

const { rows: [resumen] } = await pool.query(`
  SELECT count(*)::int AS mensajes, count(DISTINCT chat_id)::int AS chats,
         to_char(min(ts), 'DD/MM/YYYY') AS desde, to_char(max(ts), 'DD/MM/YYYY HH24:MI') AS ultimo
  FROM messages`)
console.log(`\nMemoria: ${resumen.mensajes} mensajes en ${resumen.chats} chats (desde ${resumen.desde ?? '-'}, ultimo ${resumen.ultimo ?? '-'})`)

const { rows } = await pool.query(`
  SELECT nombre, CASE WHEN es_grupo THEN 'grupo' ELSE 'chat' END AS tipo, sin_responder,
         to_char(ultimo_mensaje, 'DD/MM HH24:MI') AS cuando, de, left(texto, 60) AS texto
  FROM pendientes
  WHERE ultimo_mensaje > now() - make_interval(days => $1)
  ORDER BY ultimo_mensaje DESC
  LIMIT 50`, [dias])

console.log(`\nPendientes de responder (ultimos ${dias} dias): ${rows.length}`)
if (rows.length) console.table(rows)
await pool.end()
