import 'dotenv/config'

const production = process.env.NODE_ENV === 'production'
const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:8080')
if (production && origin.protocol !== 'https:') throw new Error('Production APP_ORIGIN must use HTTPS.')
if (origin.origin !== origin.href.slice(0, -1)) throw new Error('APP_ORIGIN must be a bare origin.')

export const config = {
  production,
  origin: origin.origin,
  host: process.env.BIND_HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  cookie: production ? '__Host-crash-session' : 'crash-session',
  database: process.env.DATABASE_URL || '',
  webRoot: process.env.WEB_ROOT || 'dist/web',
  trustProxy: process.env.TRUST_PROXY === '1',
}

if (!config.database) throw new Error('DATABASE_URL is required.')
