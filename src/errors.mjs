export class ProxyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const invalid = (message) => new ProxyError(400, 'invalid_request_error', message);
export const upstream = (message) => new ProxyError(502, 'upstream_error', message);
