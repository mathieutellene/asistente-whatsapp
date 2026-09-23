import { readFile } from 'node:fs/promises'
import { pool } from '../db.js'

const sql = await readFile(new URL('../../schema.sql', import.meta.url), 'utf8')
await pool.query(sql)
console.log('Base de datos lista.')
await pool.end()
