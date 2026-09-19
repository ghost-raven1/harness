import { z } from 'zod';

// Поля формы могут быть временно пустыми; права и корректность плана проверяет проектный домен.
const check = z
  .object({
    id: z.string().max(200),
    title: z.string().max(500),
    command: z.string().max(4096),
    args: z.array(z.string().max(16000)).max(100),
  })
  .strict();
const stage = z
  .object({
    id: z.string().max(200),
    title: z.string().max(500),
    task: z.string().max(32000),
    role: z.string().max(200),
    dependsOn: z.array(z.string().max(200)).max(32),
    expectedResult: z.string().max(8000),
    requiredTools: z.array(z.string().max(200)).max(32),
    verification: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('commands'), checks: z.array(check).max(16) }).strict(),
      z.object({ kind: z.literal('manual'), instructions: z.string().max(8000) }).strict(),
    ]),
  })
  .strict();
export const draftPlanSchema = z
  .object({
    stages: z.array(stage).max(32),
    maxCorrections: z.number().int().min(0).max(10),
    fixBaselineFailures: z.boolean(),
  })
  .strict();
export const draftPayloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('project.create'),
      title: z.string().max(500),
      goal: z.string().max(32000),
      workspace: z.string().max(16000),
      profile: z.string().max(200),
      captureEnabled: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('project.edit'), plan: draftPlanSchema }).strict(),
]);
export type DraftPayload = z.infer<typeof draftPayloadSchema>;

/** Оставляет запас для полей IPC, чтобы отправленный черновик можно было повторить целиком. */
export function assertDraftSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 900 * 1024)
    throw new Error(
      'Черновик превышает 900 КиБ. Сократите текст или число проверок перед сохранением.',
    );
}
