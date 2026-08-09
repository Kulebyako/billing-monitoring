import type { Request, Response, NextFunction } from 'express';

type Bucket = { fails: number; firstAt: number; blockedUntil: number };

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const BLOCK_MS = 30 * 60 * 1000;

function clientIp(req: Request): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function prune(now: number): void {
  for (const [ip, b] of buckets) {
    if (b.blockedUntil < now && now - b.firstAt > WINDOW_MS) buckets.delete(ip);
  }
}

export function checkLoginRateLimit(req: Request, res: Response): boolean {
  const now = Date.now();
  prune(now);
  const ip = clientIp(req);
  const b = buckets.get(ip);
  if (b && b.blockedUntil > now) {
    const retry = Math.ceil((b.blockedUntil - now) / 1000);
    res.setHeader('Retry-After', String(retry));
    res.status(429).json({ error: 'Too many failed logins. Try again later.' });
    console.warn(`[auth] rate-limited ip=${ip} retry_after=${retry}s`);
    return false;
  }
  return true;
}

export function recordLoginFailure(req: Request): void {
  const now = Date.now();
  const ip = clientIp(req);
  let b = buckets.get(ip);
  if (!b || now - b.firstAt > WINDOW_MS) {
    b = { fails: 0, firstAt: now, blockedUntil: 0 };
    buckets.set(ip, b);
  }
  b.fails += 1;
  console.warn(`[auth] failed login ip=${ip} fails=${b.fails}`);
  if (b.fails >= MAX_FAILS) {
    b.blockedUntil = now + BLOCK_MS;
    console.warn(`[auth] ban ip=${ip} for ${BLOCK_MS / 60000}m (fail2ban hook)`);
  }
}

export function recordLoginSuccess(req: Request): void {
  buckets.delete(clientIp(req));
}

export function loginRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!checkLoginRateLimit(req, res)) return;
  next();
}
