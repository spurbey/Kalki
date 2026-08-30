export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 404 | 409 | 502 | 503,
    readonly retryable = false,
  ) {
    super(message);
  }
}
