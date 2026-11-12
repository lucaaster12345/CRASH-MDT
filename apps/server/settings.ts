import { db, type Database } from './db.js'
import { defaultImageHosts } from '../../packages/shared/validation.js'

export async function imageHosts(tx: Database = db): Promise<string[]> {
  const setting = await tx.setting.findUnique({ where: { key: 'imageHosts' } })
  if (
    Array.isArray(setting?.value) &&
    setting.value.every((host): host is string => typeof host === 'string')
  )
    return setting.value
  return [...defaultImageHosts]
}
