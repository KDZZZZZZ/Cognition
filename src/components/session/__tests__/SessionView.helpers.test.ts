import { describe, expect, it } from 'vitest';
import {
  applyAssistantStreamEvent,
  extractToolCalls,
  extractToolResults,
  formatJsonPreview,
  inferActionKind,
  shouldClearAssistantPreview,
  summarizeIndexStatus,
  supportsIndexWarmup,
} from '../sessionViewUtils';

describe('SessionView helpers', () => {
  it('maps tool names to action kinds', () => {
    expect(inferActionKind('locate_relevant_segments')).toBe('read');
    expect(inferActionKind('inspect_document_visual')).toBe('read');
    expect(inferActionKind('insert_block')).toBe('create');
    expect(inferActionKind('update_file')).toBe('update');
    expect(inferActionKind('delete_block')).toBe('delete');
    expect(inferActionKind('pause_for_user_choice')).toBe('pause');
    expect(inferActionKind('deliver_task')).toBe('task');
    expect(inferActionKind('unknown')).toBe('other');
  });

  it('formats previews and extracts call/result records', () => {
    expect(formatJsonPreview(undefined)).toBe('');
    expect(formatJsonPreview({ a: 1 })).toContain('"a"');
    expect(formatJsonPreview('x'.repeat(20), 8)).toBe('xxxxxxxx…');

    const calls = extractToolCalls([
      { id: '1', function: { name: 'tool1', arguments: '{"a":1}' } },
      { id: '2', name: 'tool2', arguments: { b: 2 } },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('tool1');
    expect((calls[0].arguments as any).a).toBe(1);

    const results = extractToolResults([
      { id: '1', tool: 'tool1', result: { success: true, data: { ok: 1 } } },
      { id: '2', name: 'tool2', result: { success: false, error: 'bad' } },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].error).toBe('bad');
  });

  it('falls back to generated ids and unknown tool names when payload is incomplete', () => {
    const calls = extractToolCalls([
      { function: { arguments: '{"z":1}' } },
      {},
    ]);
    expect(calls[0].id).toBe('0');
    expect(calls[0].name).toBe('unknown_tool');
    expect(calls[1].name).toBe('unknown_tool');

    const results = extractToolResults([
      {},
      { name: 'tool-name' },
    ]);
    expect(results[0].id).toBe('0');
    expect(results[0].tool).toBe('unknown_tool');
    expect(results[0].success).toBe(false);
    expect(results[1].tool).toBe('tool-name');
  });

  it('summarizes index status, warmup support, and assistant stream state', () => {
    expect(supportsIndexWarmup('pdf')).toBe(true);
    expect(supportsIndexWarmup('folder' as any)).toBe(false);

    expect(summarizeIndexStatus({ parse_status: 'ready', embedding_status: 'ready' }).label).toBe('Index ready');
    expect(summarizeIndexStatus({ parse_status: 'pending', embedding_status: 'pending' }).needsWarmup).toBe(true);
    expect(summarizeIndexStatus({ parse_status: 'ready', embedding_status: 'disabled' }).label).toBe('Embedding disabled');

    const started = applyAssistantStreamEvent(null, {
      task_id: 'task-1',
      event_type: 'started',
      round: 1,
      timestamp: '2026-02-27T00:00:00Z',
    });
    expect(started?.content).toBe('');

    const progressed = applyAssistantStreamEvent(started, {
      task_id: 'task-1',
      event_type: 'delta',
      delta: 'hello',
      timestamp: '2026-02-27T00:00:01Z',
    });
    expect(progressed?.content).toBe('hello');

    const completed = applyAssistantStreamEvent(progressed, {
      task_id: 'task-1',
      event_type: 'completed',
      content: 'hello world',
      timestamp: '2026-02-27T00:00:02Z',
    });
    expect(completed?.content).toBe('hello world');
    expect(shouldClearAssistantPreview('tool_started')).toBe(true);
    expect(shouldClearAssistantPreview('context_ready')).toBe(false);
  });
});
