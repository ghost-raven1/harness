import { z } from 'zod';
import {
  projectInputs,
  projectListSchema,
  projectViewSchema,
  projectPurgePreviewSchema,
} from '../../projects/schema.js';
import { command, count } from './common.js';
import { projectReadInputs, projectReadOutputs } from '../../projects/read-schema.js';
import { planReadCommands } from '../../projects/plan-schema.js';

/** Проекты управляются человеком через локальный IPC; инструменты MCP их не экспортируют. */
export const projectCommands = {
  ...planReadCommands,
  'projects.reports': command(projectReadInputs.reports, projectReadOutputs.reports),
  'projects.checkOutput': command(projectReadInputs.checkOutput, projectReadOutputs.checkOutput),
  'projects.review': command(projectReadInputs.review, projectReadOutputs.review),
  'projects.exportPreview': command(
    projectReadInputs.exportPreview,
    projectReadOutputs.exportPreview,
  ),
  'projects.exportReport': command(projectReadInputs.exportReport, projectReadOutputs.exportReport),
  'projects.list': command(projectInputs.list, projectListSchema),
  'projects.detail': command(projectInputs.detail, projectViewSchema),
  'projects.create': command(projectInputs.create, projectViewSchema),
  'projects.plan': command(projectInputs.plan, projectViewSchema),
  'projects.editPlan': command(projectInputs.editPlan, projectViewSchema),
  'projects.acceptPlan': command(projectInputs.acceptPlan, projectViewSchema),
  'projects.pause': command(projectInputs.pause, projectViewSchema),
  'projects.resume': command(projectInputs.resume, projectViewSchema),
  'projects.cancel': command(projectInputs.cancel, projectViewSchema),
  'projects.message': command(projectInputs.message, projectViewSchema),
  'projects.manualCheck': command(projectInputs.manualCheck, projectViewSchema),
  'projects.recheck': command(projectInputs.recheck, projectViewSchema),
  'projects.accept': command(projectInputs.accept, projectViewSchema),
  'projects.archive': command(projectInputs.archive, projectViewSchema),
  'projects.resolve': command(projectInputs.resolve, projectViewSchema),
  'projects.purgePreview': command(projectInputs.purgePreview, projectPurgePreviewSchema),
  'projects.purge': command(
    projectInputs.purge,
    z.object({ purged: z.literal(true), projectId: z.string(), runs: count }),
  ),
};
