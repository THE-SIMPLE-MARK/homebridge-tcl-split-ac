export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function errMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as Record<string, unknown>;
    if (typeof err['message'] === 'string') return err['message'];
    if (typeof err['code'] === 'string') return err['code'];
  }
  if (typeof e === 'string') return e;
  return JSON.stringify(e) || 'unknown error';
}
