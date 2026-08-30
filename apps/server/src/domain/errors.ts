export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}
