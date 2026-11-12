import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

export const exec = promisify(execFile)
export const masterPassword = 'Test fixture only ' + randomBytes(16).toString('hex')
export const issuedPassword = 'Test investigator only ' + randomBytes(16).toString('hex')

export function testDatabase() {
  const connection = process.env.TEST_DATABASE_URL
  if (!connection || !/^crash_mdt_test(?:_[a-z0-9]+)?$/.test(new URL(connection).pathname.slice(1))) {
    throw new Error('TEST_DATABASE_URL must point to a disposable crash_mdt_test database.')
  }
  return connection
}

export function testEnvironment(origin: string) {
  const url = new URL(origin)
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: testDatabase(),
    APP_ORIGIN: origin,
    BIND_HOST: '127.0.0.1',
    PORT: url.port,
    TRUST_PROXY: '0',
    DISPLAY_TIMEZONE: 'UTC',
  }
}

export async function account(origin: string, command: 'bootstrap' | 'recover', password: string) {
  const server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/account-cli.ts', command], {
    env: testEnvironment(origin),
  })
  let output = ''
  server.stdout.on('data', (data) => {
    output += String(data)
  })
  server.stderr.on('data', (data) => {
    output += String(data)
  })
  const exited = once(server, 'exit')
  server.stdin.end(password + '\n')
  const [code] = await exited
  assert.equal(code, 0, output)
  return output
}

export async function start(origin: string) {
  const server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/index.ts'], {
    env: testEnvironment(origin),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout?.on('data', (data) => {
    output += String(data)
    if (process.env.TEST_DEBUG) process.stdout.write(data)
  })
  server.stderr?.on('data', (data) => {
    output += String(data)
    if (process.env.TEST_DEBUG) process.stderr.write(data)
  })
  try {
    await until(
      async () => {
        if (server.exitCode !== null) throw new Error(output)
        const response = await fetch(origin + '/api/health', {
          signal: AbortSignal.timeout(750),
        }).catch(() => null)
        return !!response?.ok
      },
      'Server health check',
      12000,
    )
  } catch (error) {
    server.kill('SIGKILL')
    throw error
  }
  return server
}

export async function kill(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null) return
  const exited = once(server, 'exit')
  server.kill('SIGKILL')
  await exited
}

export async function until(work: () => Promise<boolean> | boolean, label: string, timeout = 9000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await work()) return
    await delay(100)
  }
  throw new Error(label + ' timed out.')
}

export class Client {
  cookie = ''
  csrf = ''
  constructor(public origin: string) {}
  async call<T = unknown>(
    path: string,
    method = 'GET',
    data?: unknown,
    expected = 200,
    omitOrigin = false,
  ) {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf })
    if (this.cookie) headers.set('Cookie', this.cookie)
    if (!omitOrigin) headers.set('Origin', this.origin)
    const response = await fetch(this.origin + '/api' + path, {
      method,
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    })
    const body = response.status === 204 ? undefined : await response.json()
    assert.equal(response.status, expected, method + ' ' + path + ' · ' + JSON.stringify(body))
    const cookie = response.headers.get('set-cookie')
    if (cookie) this.cookie = cookie.split(';')[0]!
    if (body?.csrf) this.csrf = body.csrf
    return body as T
  }
}

export async function provision(
  admin: Client,
  role: 'ADMIN' | 'INVESTIGATOR' | 'VIEWER',
  name: string,
) {
  const username = name.toLowerCase().replace(/[^a-z]/g, '') + '-' + randomBytes(4).toString('hex')
  const { user, code } = await admin.call<{ user: { id: string; username: string }; code: string }>(
    '/accounts',
    'POST',
    { username, displayName: name, role },
    201,
  )
  const client = new Client(admin.origin)
  await client.call('/auth/activate', 'POST', { code, password: issuedPassword })
  return { user, client, code }
}
