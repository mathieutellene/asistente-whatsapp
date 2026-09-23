// Lista de numeros que el asistente NO guarda ni usa nunca.
// Vive en %LOCALAPPDATA%\asistente-whatsapp\excluidos.txt (solo en este ordenador, fuera de OneDrive).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

const TEMPLATE = [
  '# Numeros que el asistente NO debe guardar ni usar nunca.',
  '# Uno por linea, con prefijo de pais. Ejemplos validos:',
  '#   34600111222',
  '#   +34 600 111 222',
  '# Los espacios, guiones y el + se ignoran. Las lineas que empiezan por # tambien.',
  '',
].join('\r\n')

function load(file) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, TEMPLATE)
  }
  const set = new Set()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    let d = t.replace(/\D/g, '')
    if (d.startsWith('00')) d = d.slice(2)
    if (d.length === 9 && /^[6789]/.test(d)) d = '34' + d // numero espanol escrito sin prefijo
    if (d.length >= 8) set.add(d)
  }
  return set
}

export const excludedNumbers = load(config.excludeFile)

/** Devuelve true si el jid (numero@s.whatsapp.net) es de un numero excluido. */
export function isExcluded(jid) {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return false
  return excludedNumbers.has(jid.split('@')[0].split(':')[0])
}

export const excludedJids = () => [...excludedNumbers].map(d => `${d}@s.whatsapp.net`)
