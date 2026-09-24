// Busqueda en internet para dar contexto a un borrador (horarios, direcciones, resultados, el tiempo...).
// Al buscador (DuckDuckGo) SOLO llega una consulta corta que la IA local redacta sin nombres ni datos
// privados; ademas se borran telefonos y correos. Nunca se envia la conversacion.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

const ENTITIES = { amp: '&', quot: '"', lt: '<', gt: '>', nbsp: ' ', '#39': "'", '#x27': "'" }
const strip = s => s.replace(/<[^>]+>/g, '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()]
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  return m
}).replace(/\s+/g, ' ').trim()

function siteOf(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com')
    const real = u.searchParams.get('uddg') || u.href
    return new URL(real).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Quita de una consulta cualquier cosa que parezca un dato personal. */
export function sanitizeQuery(q) {
  return String(q || '')
    .replace(/\S+@\S+/g, ' ') // correos
    .replace(/\+?\d[\d\s.-]{5,}\d/g, ' ') // telefonos y numeros largos
    .replace(/[^\p{L}\p{N}\s:'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** Lee los resultados de la pagina HTML de DuckDuckGo. Exportado para las pruebas. */
export function parseResults(html, max = 3) {
  const out = []
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/g
  let m
  while ((m = re.exec(html)) && out.length < max) {
    const titulo = strip(m[2])
    if (titulo) out.push({ titulo: titulo.slice(0, 120), resumen: strip(m[3]).slice(0, 240), sitio: siteOf(m[1]) })
  }
  return out
}

export async function webSearch(query, max = 3) {
  const q = sanitizeQuery(query)
  if (q.length < 3) return []
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ q, kl: 'es-es' }),
    signal: AbortSignal.timeout(12_000),
  })
  const html = await res.text()
  const results = parseResults(html, max)
  if (!results.length && /anomaly|captcha|challenge/i.test(html)) throw new Error('el buscador pidio una verificacion; se probara en el siguiente borrador')
  return results
}
