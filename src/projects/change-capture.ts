import { basename } from 'node:path';
import type { Config } from '../configuration/schema.js';
import type { ProjectCaptureSettings } from '../configuration/project-capture.js';
import { PolicyService } from '../policy/service.js';
import type { ContentUnavailableReason } from './change-content-schema.js';

export interface WorkspaceCaptureOptions {
  settings: ProjectCaptureSettings;
  config: Config;
  role?: string;
  authorityRoles?: string[];
  link?: { runId: string; changeSetId: string; kind: 'after' };
}
const policy = new PolicyService();
/** Автоматическая копия требует закреплённого allow; человеческие разрешения не расходуются. */
export function contentUnavailable(
  options: WorkspaceCaptureOptions,
  path: string,
  size: bigint,
): ContentUnavailableReason | undefined {
  if (!options.settings.enabled) return 'disabled';
  if (
    /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?)$/i.test(
      basename(path),
    ) ||
    /(?:^|\/)\.aws\/credentials$/i.test(path) ||
    /\.(?:pem|key|p12|pfx)$/i.test(path)
  )
    return 'policy';
  if (
    policy.decide(
      options.config,
      {
        role: options.role ?? options.config.defaultRole,
        authorityRoles: options.authorityRoles ?? [options.config.defaultRole],
      },
      'fs.read',
      { path },
    ) !== 'allow'
  )
    return 'policy';
  if (size > BigInt(options.settings.fileBytes)) return 'too-large';
  return undefined;
}
/** Проверяет кодировку без замены неверных байтов и не сохраняет двоичное содержимое. */
export function textUnavailable(bytes: Buffer): ContentUnavailableReason | undefined {
  if (bytes.includes(0)) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'encoding';
  }
  return undefined;
}
