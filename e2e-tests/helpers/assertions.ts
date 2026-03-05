import type { CapturedExchange } from './chatCapture';

function getData(responseBody: any): any {
  return responseBody?.data || responseBody || {};
}

export function expectTaskPath(responseBody: any, expectedStepTypes: string[]): string[] {
  const tasks = getData(responseBody)?.task_registry?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('Missing task_registry.tasks in chat response.');
  }
  const actual = (tasks[0]?.steps || []).map((step: any) => String(step?.type || ''));
  let cursor = 0;
  for (const stepType of expectedStepTypes) {
    const index = actual.indexOf(stepType, cursor);
    if (index === -1) {
      throw new Error(`Expected step path to include ${stepType} after index ${cursor - 1}. actual=[${actual.join(', ')}]`);
    }
    cursor = index + 1;
  }
  return actual;
}

export function expectPendingDiffVisible(event: any): any {
  const pending = event?.data?.event || event?.event || event;
  if (!pending?.id || pending?.status !== 'pending') {
    throw new Error('Expected a pending diff event, but none was found.');
  }
  return pending;
}

export function expectViewportInjected(requestBody: any, expectedPage?: number): void {
  if (!requestBody || !requestBody.active_file_id) {
    throw new Error('Missing active_file_id in chat request payload.');
  }
  if (typeof expectedPage === 'number' && requestBody.active_page !== expectedPage) {
    throw new Error(`Expected active_page=${expectedPage}, got ${requestBody.active_page}`);
  }
}

export function expectPermissionRevoked(exchange: CapturedExchange, forbiddenFileName: string, forbiddenFileId: string): void {
  const requestBody = exchange.requestBody || {};
  const responseData = getData(exchange.responseBody);
  const contextFiles = Array.isArray(requestBody.context_files) ? requestBody.context_files.map(String) : [];
  if (contextFiles.includes(forbiddenFileId)) {
    throw new Error(`Revoked file still present in context_files: ${forbiddenFileId}`);
  }
  const citations = Array.isArray(responseData.citations) ? responseData.citations : [];
  if (citations.some((item: any) => String(item?.file_id || '') === forbiddenFileId)) {
    throw new Error(`Revoked file still present in citations: ${forbiddenFileId}`);
  }
  const content = String(responseData.content || '');
  if (content.includes(forbiddenFileId)) {
    throw new Error(`Assistant response leaked revoked file id: ${forbiddenFileId}`);
  }
  if (forbiddenFileName && content.includes(forbiddenFileName)) {
    throw new Error(`Assistant response leaked revoked file name: ${forbiddenFileName}`);
  }
  const permissionDenied = /无权|没有权限|无法访问|do not have access|permission/i.test(content);
  if (!permissionDenied) {
    throw new Error(`Assistant did not acknowledge revoked access for ${forbiddenFileName}.`);
  }
}

export function expectCompactTriggered(responseBody: any): any {
  const compactMeta = getData(responseBody)?.compact_meta;
  if (!compactMeta?.triggered) {
    throw new Error('Expected compact_meta.triggered=true.');
  }
  if (!compactMeta?.compaction_id) {
    throw new Error('Expected compact_meta.compaction_id to exist.');
  }
  if ((compactMeta.after_tokens || 0) >= (compactMeta.before_tokens || 0)) {
    throw new Error(`Expected after_tokens < before_tokens, got before=${compactMeta.before_tokens}, after=${compactMeta.after_tokens}`);
  }
  return compactMeta;
}

export function expectCitationToPage(responseBody: any, expectedPage: number): void {
  const citations = Array.isArray(getData(responseBody)?.citations) ? getData(responseBody).citations : [];
  if (!citations.some((item: any) => Number(item?.page) === expectedPage)) {
    throw new Error(`Expected at least one citation to page ${expectedPage}.`);
  }
}

export function expectResumeSucceeded(eventsOrResponse: any): void {
  const text = JSON.stringify(eventsOrResponse);
  if (!/task_resumed|paused":false|Continue Task|resumed/i.test(text)) {
    throw new Error('Expected resume evidence, but none was found.');
  }
}

export function extractToolNames(responseBody: any): string[] {
  const data = getData(responseBody);
  const toolCalls = Array.isArray(data?.tool_calls) ? data.tool_calls : [];
  const toolResults = Array.isArray(data?.tool_results) ? data.tool_results : [];
  const names = new Set<string>();
  for (const item of toolCalls) {
    const name = String(item?.function?.name || item?.name || '').trim();
    if (name) names.add(name);
  }
  for (const item of toolResults) {
    const name = String(item?.tool || item?.name || '').trim();
    if (name) names.add(name);
  }
  return [...names];
}

export function hasAnyToolName(responseBody: any, candidates: string[]): boolean {
  const names = extractToolNames(responseBody);
  return candidates.some((candidate) => names.includes(candidate));
}
