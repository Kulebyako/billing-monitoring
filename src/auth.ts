import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { getDb } from './db.js';

const COOKIE = 'sb_session';

export function createSession(): string {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  getDb()
    .prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)')
    .run(token, expires);
  return token;
}

export function destroySession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function isValidSession(token?: string): boolean {
  if (!token) return false;
  getDb().prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  const row = getDb()
    .prepare('SELECT token FROM sessions WHERE token = ? AND expires_at >= datetime(\'now\')')
    .get(token);
  return !!row;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE];
  if (isValidSession(token)) {
    next();
    return;
  }
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.redirect('/login');
}

export function tryLogin(password: string): string | null {
  if (password !== config.panelPassword) return null;
  return createSession();
}

export { COOKIE };
