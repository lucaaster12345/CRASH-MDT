import type { ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'
import { Prisma } from '../../generated/prisma/client.js'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export function check(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new HttpError(status, message)
}

export function checkVersion(actual: number, expected: number) {
  check(
    actual === expected,
    409,
    'This record changed while you were editing. Review the latest version before saving again.',
  )
}

export const errors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error)
    return
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message })
    return
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    res.status(422).json({
      error: issue
        ? [issue.path.join('.'), issue.message].filter(Boolean).join(' · ')
        : 'Check the submitted fields.',
    })
    return
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'A record already uses this value.' })
      return
    }
    if (error.code === 'P2003' || error.code === 'P2025') {
      res.status(409).json({ error: 'A referenced record changed or no longer exists.' })
      return
    }
  }
  if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
    res.status(400).json({ error: 'Invalid JSON request.' })
    return
  }
  if (typeof error === 'object' && error?.status === 413) {
    res.status(413).json({ error: 'Request is too large.' })
    return
  }
  console.error('Request failed', error instanceof Error ? error.name : 'Unknown error')
  res.status(500).json({ error: 'The server could not complete the request.' })
}
