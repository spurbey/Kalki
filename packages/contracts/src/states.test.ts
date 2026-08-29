import { describe, expect, it } from 'vitest';
import {
  RunStatusSchema,
  canTransitionRun,
  canTransitionTask,
} from './states.js';

describe('task state machine', () => {
  it('allows the reviewed production path', () => {
    expect(canTransitionTask('aligning', 'awaiting_task_confirmation')).toBe(true);
    expect(canTransitionTask('awaiting_task_confirmation', 'exploring')).toBe(true);
    expect(canTransitionTask('exploring', 'awaiting_schema_review')).toBe(true);
    expect(canTransitionTask('awaiting_schema_review', 'building')).toBe(true);
    expect(canTransitionTask('building', 'testing')).toBe(true);
    expect(canTransitionTask('testing', 'awaiting_production_confirmation')).toBe(true);
    expect(canTransitionTask('awaiting_production_confirmation', 'production_running')).toBe(true);
    expect(canTransitionTask('production_running', 'finalizing')).toBe(true);
    expect(canTransitionTask('finalizing', 'completed')).toBe(true);
  });

  it('allows revision without skipping review gates', () => {
    expect(canTransitionTask('awaiting_task_confirmation', 'aligning')).toBe(true);
    expect(canTransitionTask('awaiting_schema_review', 'exploring')).toBe(true);
    expect(canTransitionTask('testing', 'building')).toBe(true);
    expect(canTransitionTask('awaiting_production_confirmation', 'building')).toBe(true);
  });

  it('keeps terminal task states closed', () => {
    expect(canTransitionTask('completed', 'building')).toBe(false);
    expect(canTransitionTask('failed', 'testing')).toBe(false);
    expect(canTransitionTask('cancelled', 'aligning')).toBe(false);
  });

  it('rejects skipped human gates', () => {
    expect(canTransitionTask('aligning', 'production_running')).toBe(false);
    expect(canTransitionTask('testing', 'production_running')).toBe(false);
  });
});

describe('run state machine', () => {
  it('uses the bounded test lifecycle', () => {
    expect(canTransitionRun('test', 'running', 'completed')).toBe(true);
    expect(canTransitionRun('test', 'running', 'failed')).toBe(true);
    expect(canTransitionRun('test', 'completed', 'running')).toBe(false);
  });

  it('requires production authorization before running', () => {
    expect(canTransitionRun('production', 'awaiting_confirmation', 'authorized')).toBe(true);
    expect(canTransitionRun('production', 'awaiting_confirmation', 'running')).toBe(false);
    expect(canTransitionRun('production', 'authorized', 'running')).toBe(true);
    expect(canTransitionRun('production', 'running', 'finalizing')).toBe(true);
    expect(canTransitionRun('production', 'finalizing', 'completed')).toBe(true);
  });

  it('does not expose the old created status', () => {
    expect(RunStatusSchema.safeParse('created').success).toBe(false);
  });
});
