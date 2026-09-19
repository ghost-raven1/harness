import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const protocolVersion = 1;
export const storageVersion = 1;
const packageSchema = z.object({ version: z.string().min(1) });
const buildSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.string().regex(/^[a-f0-9]{64}$/),
  dependencies: z.string().regex(/^[a-f0-9]{64}$/),
});
const version = packageSchema.parse(
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')),
).version;

/** Манифест создаётся после smoke-проверки сборки; исходники и staging ещё не имеют её ID. */
function readBuildId(): string | null {
  try {
    const manifest = buildSchema.parse(
      JSON.parse(readFileSync(new URL('../build-manifest.json', import.meta.url), 'utf8')),
    );
    return createHash('sha256')
      .update(manifest.sources + ':' + manifest.dependencies)
      .digest('hex');
  } catch {
    return null;
  }
}
const buildId = readBuildId();

/** Версия берётся из package.json, отпечаток — из существующего манифеста сборки. */
export function applicationIdentity() {
  return {
    version,
    buildId,
    protocolVersion,
    storageVersion,
    capabilities: [
      'typed-commands',
      'protocol-negotiation',
      'history-verification',
      'derived-indexes',
      'projects-v1',
      'projects-review-v1',
      'projects-diff-v1',
    ],
  };
}
