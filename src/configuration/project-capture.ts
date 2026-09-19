import { z } from 'zod';

/** Пределы копий исходников не являются квотами исполнения или модели. */
export const projectCaptureSchema = z
  .object({
    enabled: z.boolean().optional(),
    fileBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024)
      .optional(),
    projectBytes: z.number().int().positive().safe().optional(),
    totalBytes: z.number().int().positive().safe().optional(),
  })
  .strict();
export const projectCaptureSettingsSchema = projectCaptureSchema.required();
export type ProjectCaptureSettings = z.infer<typeof projectCaptureSettingsSchema>;

/** Применяет начальные настройки только к новым проектам; старые записи не дополняются. */
export function resolveCaptureSettings(
  authored?: z.infer<typeof projectCaptureSchema>,
): ProjectCaptureSettings {
  return {
    enabled: authored?.enabled ?? true,
    fileBytes: authored?.fileBytes ?? 1024 * 1024,
    projectBytes: authored?.projectBytes ?? 100 * 1024 * 1024,
    totalBytes: authored?.totalBytes ?? 1024 * 1024 * 1024,
  };
}
