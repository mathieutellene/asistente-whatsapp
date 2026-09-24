// Historial de Chrome del Huawei (solo lectura): se copia el archivo y se busca en los titulos
// de las paginas visitadas en los ultimos dias. No sale nada del ordenador.
import { copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HISTORY = `${process.env.LOCALAPPDATA || ''}/Google/Chrome/User Data/Default/History`
const EPOCH_1601_MS = 11644473600000n // Chrome cuenta microsegundos desde 1601

export async function chromeSearch(words, { days = 3, max = 3 } = {}) {
  if (!words.length) return []
  let sqlite
  try { sqlite = await import('node:sqlite') } catch { throw new Error('esta version de Node no trae SQLite') }
  const tmp = join(tmpdir(), `asistente-chrome-${process.pid}.db`)
  await copyFile(HISTORY, tmp) // Chrome bloquea el original mientras esta abierto
  try {
    const db = new sqlite.DatabaseSync(tmp, { readOnly: true })
    try {
      const since = (BigInt(Date.now() - days * 864e5) + EPOCH_1601_MS) * 1000n
      const w = words.slice(0, 4)
      const rows = db.prepare(
        `SELECT title, url FROM urls WHERE last_visit_time > ? AND (${w.map(() => 'title LIKE ?').join(' OR ')})
         ORDER BY last_visit_time DESC LIMIT ${Number(max)}`,
      ).all(since, ...w.map(x => `%${x}%`))
      return rows.filter(r => r.title).map(r => {
        let sitio = ''
        try { sitio = new URL(r.url).hostname.replace(/^www\./, '') } catch { /* url rara */ }
        return { titulo: r.title.slice(0, 120), sitio }
      })
    } finally {
      db.close()
    }
  } finally {
    await rm(tmp, { force: true })
  }
}
