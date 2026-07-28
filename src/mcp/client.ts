export type GatewayRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string | undefined>;
};

export type GatewayFetch = (request: Request) => Promise<Response>;

export class GatewayApiError extends Error {
  constructor(
    readonly status: number,
    readonly response: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayApiError';
  }
}

function responseMessage(status: number, value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {
    return value.message;
  }
  return `WhatsApp Gateway request failed with HTTP ${status}`;
}

export class GatewayApiClient {
  constructor(
    private readonly fetchRequest: GatewayFetch,
    private readonly authorizationHeaders: Record<string, string>,
    private readonly baseUrl = 'http://gateway.internal',
  ) {}

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: GatewayRequestOptions = {},
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const headers = new Headers(this.authorizationHeaders);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined) headers.set(name, value);
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(options.body);
    }
    const response = await this.fetchRequest(new Request(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    }));
    const text = await response.text();
    let value: unknown = null;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    if (!response.ok) {
      throw new GatewayApiError(response.status, value, responseMessage(response.status, value));
    }
    return value;
  }
}

export function authorizationHeadersFrom(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ['authorization', 'x-api-key', 'cookie']) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

export function remoteGatewayClient(baseUrl: string, apiKey: string): GatewayApiClient {
  return new GatewayApiClient(
    (request) => fetch(request),
    { authorization: `Bearer ${apiKey}` },
    baseUrl,
  );
}
