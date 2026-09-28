import { GitHubError } from './github.ts'

export class HttpError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 415 | 502
  readonly code: string
  readonly details?: unknown

  constructor(status: HttpError['status'], code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details)

export const notFound = (entity: string, ref: string | number) =>
  new HttpError(404, 'not_found', `${entity} "${ref}" not found`)

export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details)

/** GitHub turning a request down (name taken, no access, missing scope) is the caller's to fix; anything else isn't. */
export const gitHubFailure = (error: unknown) =>
  error instanceof GitHubError && error.status < 500
    ? new HttpError(400, 'github_error', error.message)
    : new HttpError(502, 'github_error', `Could not reach GitHub: ${(error as Error).message}`)
