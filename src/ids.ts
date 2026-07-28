import { randomUUID } from 'node:crypto';

export const id = (prefix: 'ten' | 'wa' | 'ari' | 'msg' | 'evt' | 'cmd' | 'whe' | 'whd' | 'aud' | 'mup') =>
  `${prefix}_${randomUUID().replaceAll('-', '')}`;
