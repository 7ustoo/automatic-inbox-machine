import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { DATA_DIR } from './os-paths.mjs';

const RESUME_DIR = join(DATA_DIR, 'profile');
const ALLOWED = Object.freeze({
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
});
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export const RESUME_TEMPLATES = new Set(['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM']);

function safeDisplayName(name, extension) {
  const clean = basename(String(name || `resume${extension}`))
    .replace(/[\r\n"\\/:*?<>|]+/g, '_')
    .trim();
  return clean.toLowerCase().endsWith(extension) ? clean : `resume${extension}`;
}

export function resumePath(config) {
  const storedName = String(config?.profile?.resume?.storedName || '');
  if (!/^resume\.(?:pdf|docx?)$/i.test(storedName)) return '';
  return join(RESUME_DIR, storedName);
}

export function resumeStatus(config) {
  const path = resumePath(config);
  const present = Boolean(path && existsSync(path));
  return {
    present,
    enabled: present && config?.profile?.resume?.enabled !== false,
    filename: present ? String(config.profile.resume.filename || basename(path)) : '',
    contentType: present ? String(config.profile.resume.contentType || ALLOWED[extname(path).toLowerCase()] || 'application/octet-stream') : ''
  };
}

export function saveResumeUpload({ filename, dataBase64 }) {
  const extension = extname(String(filename || '')).toLowerCase();
  const contentType = ALLOWED[extension];
  if (!contentType) throw new Error('Resume must be a PDF, DOC, or DOCX file.');

  const encoded = String(dataBase64 || '').replace(/^data:[^,]+,/, '');
  if (!encoded || !/^[a-z0-9+/=\r\n]+$/i.test(encoded)) throw new Error('Resume upload is not valid base64 data.');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length) throw new Error('Resume file is empty.');
  if (buffer.length > MAX_RESUME_BYTES) throw new Error('Resume must be 10 MB or smaller.');

  mkdirSync(RESUME_DIR, { recursive: true });
  for (const candidate of Object.keys(ALLOWED)) rmSync(join(RESUME_DIR, `resume${candidate}`), { force: true });
  const storedName = `resume${extension}`;
  writeFileSync(join(RESUME_DIR, storedName), buffer, { mode: 0o600 });
  return { storedName, filename: safeDisplayName(filename, extension), contentType, bytes: buffer.length };
}

export function removeResume() {
  for (const extension of Object.keys(ALLOWED)) rmSync(join(RESUME_DIR, `resume${extension}`), { force: true });
}

export function attachmentsForReply(config, template) {
  if (!RESUME_TEMPLATES.has(String(template || ''))) return [];
  const status = resumeStatus(config);
  const path = resumePath(config);
  if (!status.enabled || !path) return [];
  return [{ filename: status.filename, contentType: status.contentType, path, content: readFileSync(path) }];
}
