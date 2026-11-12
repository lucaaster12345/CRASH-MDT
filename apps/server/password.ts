import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export const token = () => randomBytes(32).toString('base64url')
export const digest = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex')
const parameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const dummy = 'scrypt-v1:00000000000000000000000000000000:' + '0'.repeat(128)

function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, parameters, (error, value) => (error ? reject(error) : resolve(value)))
  })
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  return 'scrypt-v1:' + salt.toString('hex') + ':' + (await derive(password, salt)).toString('hex')
}

export async function verifyPassword(password: string, hash: string | null | undefined) {
  const [, salt, expected] = (hash || dummy).split(':')
  const actual = await derive(password, Buffer.from(salt!, 'hex'))
  return timingSafeEqual(actual, Buffer.from(expected!, 'hex')) && !!hash
}
