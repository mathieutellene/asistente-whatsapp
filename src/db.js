import pg from 'pg'
import { config } from './config.js'

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 3 })

const MSG_COLS = ['chat_id', 'msg_id', 'from_me', 'sender_jid', 'sender_name', 'ts', 'type', 'text', 'quoted_id', 'mentions']

/** Inserta mensajes en bloques; ignora los que ya existen. Devuelve cuántos son nuevos. */
export async function insertMessages(rows) {
  let inserted = 0
  for (let i = 0; i < rows.length; i += 300) {
    const chunk = rows.slice(i, i + 300)
    const params = []
    const tuples = chunk.map((row, j) => {
      MSG_COLS.forEach(col => params.push(row[col] ?? null))
      return '(' + MSG_COLS.map((_, k) => '$' + (j * MSG_COLS.length + k + 1)).join(',') + ')'
    })
    const res = await pool.query(
      `INSERT INTO messages (${MSG_COLS.join(',')}) VALUES ${tuples.join(',')}
       ON CONFLICT (chat_id, msg_id) DO NOTHING`,
      params,
    )
    inserted += res.rowCount
  }
  return inserted
}

/**
 * Inserta o actualiza solo los campos presentes (undefined = no tocar).
 * `keep` son columnas donde un null entrante no borra el valor guardado.
 */
async function upsert(table, key, row, fields, keep) {
  const cols = [key, ...fields.filter(f => row[f] !== undefined)]
  const updates = cols.slice(1).map(c =>
    keep.includes(c) ? `${c} = COALESCE(EXCLUDED.${c}, ${table}.${c})` : `${c} = EXCLUDED.${c}`)
  const action = updates.length ? `UPDATE SET ${updates.join(', ')}, updated_at = now()` : 'NOTHING'
  await pool.query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})
     ON CONFLICT (${key}) DO ${action}`,
    cols.map(c => row[c]),
  )
}

export const upsertChat = chat =>
  upsert('chats', 'chat_id', chat, ['name', 'is_group', 'archived', 'muted_until'], ['name'])

export const upsertContact = contact =>
  upsert('contacts', 'jid', contact, ['name', 'notify'], ['name', 'notify'])

/**
 * Borra TODO lo relacionado con estos numeros (chats, sus mensajes en grupos, contacto, menciones)
 * y compacta las tablas para que los datos borrados no queden en los ficheros de la base de datos.
 */
export async function purgeJids(jids) {
  if (!jids.length) return 0
  const c = await pool.connect()
  let deleted = 0
  try {
    await c.query('BEGIN')
    const { rows } = await c.query('SELECT lid FROM lid_map WHERE pn = ANY($1)', [jids])
    const all = [...jids, ...rows.map(r => r.lid)]
    deleted += (await c.query('DELETE FROM messages WHERE chat_id = ANY($1) OR sender_jid = ANY($1)', [all])).rowCount
    deleted += (await c.query('UPDATE messages SET mentions = NULL WHERE mentions && $1::text[]', [all])).rowCount
    deleted += (await c.query('DELETE FROM chats WHERE chat_id = ANY($1)', [all])).rowCount
    deleted += (await c.query('DELETE FROM contacts WHERE jid = ANY($1)', [all])).rowCount
    deleted += (await c.query('DELETE FROM lid_map WHERE pn = ANY($1) OR lid = ANY($1)', [all])).rowCount
    await c.query('COMMIT')
  } catch (err) {
    await c.query('ROLLBACK')
    throw err
  } finally {
    c.release()
  }
  if (deleted) await pool.query('VACUUM FULL messages, chats, contacts, lid_map')
  return deleted
}

export async function getPnForLid(lid) {
  const { rows } = await pool.query('SELECT pn FROM lid_map WHERE lid = $1', [lid])
  return rows[0]?.pn || null
}

/** Guarda lid→número y mueve todo lo que se guardó con el @lid al número real. */
export async function mergeLid(lid, pn) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query('INSERT INTO lid_map (lid, pn) VALUES ($1, $2) ON CONFLICT (lid) DO UPDATE SET pn = EXCLUDED.pn', [lid, pn])
    await c.query(
      `UPDATE messages m SET chat_id = $2 WHERE chat_id = $1
         AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.chat_id = $2 AND x.msg_id = m.msg_id)`, [lid, pn])
    await c.query('DELETE FROM messages WHERE chat_id = $1', [lid])
    await c.query('UPDATE messages SET sender_jid = $2 WHERE sender_jid = $1', [lid, pn])
    await c.query(
      `INSERT INTO chats (chat_id, name, is_group, archived, muted_until)
       SELECT $2, name, is_group, archived, muted_until FROM chats WHERE chat_id = $1
       ON CONFLICT (chat_id) DO NOTHING`, [lid, pn])
    await c.query('DELETE FROM chats WHERE chat_id = $1', [lid])
    await c.query(
      `INSERT INTO contacts (jid, name, notify) SELECT $2, name, notify FROM contacts WHERE jid = $1
       ON CONFLICT (jid) DO UPDATE SET name = COALESCE(contacts.name, EXCLUDED.name),
                                       notify = COALESCE(contacts.notify, EXCLUDED.notify)`, [lid, pn])
    await c.query('DELETE FROM contacts WHERE jid = $1', [lid])
    await c.query('COMMIT')
  } catch (err) {
    await c.query('ROLLBACK')
    throw err
  } finally {
    c.release()
  }
}
