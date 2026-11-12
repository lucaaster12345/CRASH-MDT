import { readFile } from 'node:fs/promises'
import { db, audit } from './db.js'
import { masterUsername, password } from '../../packages/shared/validation.js'
import { hashPassword } from './password.js'

const operation = process.argv[2]
try {
  if (operation !== 'bootstrap' && operation !== 'recover')
    throw new Error(
      'Usage: npm run account -- bootstrap|recover (password on stdin or MASTER_PASSWORD_FILE).',
    )
  const existing = await db.user.findUnique({
    where: { username: masterUsername },
    select: { id: true, role: true, disabledAt: true },
  })
  if (operation === 'bootstrap' && existing) {
    if (existing.role !== 'ADMIN' || existing.disabledAt)
      throw new Error('Master account needs recovery.')
    console.log('mercia already exists. Existing credentials retained.')
  } else {
    if (operation === 'recover' && !existing) throw new Error('Run bootstrap before recovery.')
    const secretPath = process.env.MASTER_PASSWORD_FILE
    let input = ''
    if (secretPath) input = await readFile(secretPath, 'utf8')
    else {
      if (process.stdin.isTTY)
        throw new Error('Pipe a password from a secure prompt, or mount MASTER_PASSWORD_FILE.')
      process.stdin.setEncoding('utf8')
      for await (const chunk of process.stdin) {
        input += chunk
        if (input.length > 512) throw new Error('Password input is too long.')
      }
    }
    const value = password.safeParse(input.replace(/\r?\n$/, ''))
    if (!value.success) throw new Error('Use a password between 12 and 128 characters.')
    const hash = await hashPassword(value.data)
    await db.$transaction(async (tx) => {
      if (operation === 'bootstrap') {
        await tx.user.create({
          data: { username: masterUsername, displayName: 'Mercia', role: 'ADMIN', password: hash },
        })
      } else {
        await tx.user.update({
          where: { id: existing!.id },
          data: { password: hash, role: 'ADMIN', disabledAt: null },
        })
        await tx.session.deleteMany({ where: { userId: existing!.id } })
        await tx.credential.deleteMany({ where: { userId: existing!.id } })
      }
      const master = await tx.user.findUniqueOrThrow({ where: { username: masterUsername } })
      await audit(tx, null, 'account.' + operation, 'user', master.id)
    })
    console.log(
      operation === 'bootstrap' ? 'mercia created.' : 'mercia password reset and sessions revoked.',
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Account command failed.')
  process.exitCode = 1
} finally {
  await db.$disconnect()
}
