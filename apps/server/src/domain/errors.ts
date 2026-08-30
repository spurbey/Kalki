export class NotFoundError extends Error {
  readonly code = 'not_found';
  readonly status = 404;
}
