import { z } from 'zod';

export const TaskStateSchema = z.enum([
  'aligning',
  'awaiting_task_confirmation',
  'exploring',
  'awaiting_schema_review',
  'building',
  'testing',
  'awaiting_production_confirmation',
  'production_running',
  'finalizing',
  'completed',
  'failed',
  'cancelled',
]);

export type TaskState = z.infer<typeof TaskStateSchema>;

export const RunModeSchema = z.enum(['test', 'production']);
export type RunMode = z.infer<typeof RunModeSchema>;

export const RunStatusSchema = z.enum([
  'awaiting_confirmation',
  'authorized',
  'running',
  'finalizing',
  'completed',
  'failed',
  'cancelled',
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TableKindSchema = z.enum(['source', 'derived']);
export type TableKind = z.infer<typeof TableKindSchema>;

export const TASK_TRANSITIONS = {
  aligning: ['awaiting_task_confirmation', 'cancelled'],
  awaiting_task_confirmation: ['exploring', 'aligning', 'cancelled'],
  exploring: ['awaiting_schema_review', 'failed', 'cancelled'],
  awaiting_schema_review: ['building', 'exploring', 'cancelled'],
  building: ['testing', 'failed', 'cancelled'],
  testing: ['awaiting_production_confirmation', 'building', 'failed', 'cancelled'],
  awaiting_production_confirmation: ['production_running', 'building', 'cancelled'],
  production_running: ['finalizing', 'failed', 'cancelled'],
  finalizing: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Readonly<Record<TaskState, readonly TaskState[]>>;

const RUN_TRANSITIONS = {
  test: {
    running: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  },
  production: {
    awaiting_confirmation: ['authorized', 'cancelled'],
    authorized: ['running', 'failed', 'cancelled'],
    running: ['finalizing', 'failed', 'cancelled'],
    finalizing: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  },
} as const satisfies Readonly<
  Record<RunMode, Partial<Record<RunStatus, readonly RunStatus[]>>>
>;

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  const destinations = TASK_TRANSITIONS[from] as readonly TaskState[];
  return destinations.includes(to);
}

export function canTransitionRun(mode: RunMode, from: RunStatus, to: RunStatus): boolean {
  const transitions: Partial<Record<RunStatus, readonly RunStatus[]>> = RUN_TRANSITIONS[mode];
  const destinations = transitions[from];
  return destinations?.includes(to) ?? false;
}
