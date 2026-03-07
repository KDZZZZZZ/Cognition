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

export function expectNoEditorTools(responseBody: any): string[] {
  const tools = extractToolNames(responseBody);
  const editorTools = tools.filter((tool) =>
    ['update_file', 'update_block', 'insert_block', 'delete_block', 'add_file_charts_to_note'].includes(tool)
  );
  if (editorTools.length > 0) {
    throw new Error(`Expected no editor tools, got [${editorTools.join(', ')}]`);
  }
  return tools;
}

export function expectAnyToolName(responseBody: any, candidates: string[]): string {
  const tools = extractToolNames(responseBody);
  const matched = candidates.find((candidate) => tools.includes(candidate));
  if (!matched) {
    throw new Error(`Expected one of [${candidates.join(', ')}], got [${tools.join(', ')}]`);
  }
  return matched;
}

export function expectStructuredPaperCollection(
  responseBody: any,
  options?: { requireUnconfirmedMarker?: boolean }
): {
  hasQueryGroup: boolean;
  hasFilters: boolean;
  hasCandidates: boolean;
  hasReadingOrder: boolean;
  hasUnconfirmedMarker: boolean;
} {
  const content = String(getData(responseBody)?.content || '');
  const hasQueryGroup = /(query|检索词|关键词|query 组|query组)/i.test(content);
  const hasFilters = /(inclusion|exclusion|筛选标准|排除|必须|加分)/i.test(content);
  const hasCandidates = /(top\s*\d|候选|必读|可选|baseline|对照组|综述|教程)/i.test(content);
  const hasReadingOrder = /(reading order|阅读顺序|先读|section|abstract -> method|abstract→method)/i.test(content);
  const hasUnconfirmedMarker = /(待确认|无法确认|仅基于当前论文|not directly supported|insufficient evidence)/i.test(content);

  if (!hasQueryGroup || !hasFilters || !hasCandidates || !hasReadingOrder) {
    throw new Error(
      `Paper collection response missing structure: query=${hasQueryGroup}, filters=${hasFilters}, candidates=${hasCandidates}, reading=${hasReadingOrder}`
    );
  }

  if (options?.requireUnconfirmedMarker && !hasUnconfirmedMarker) {
    throw new Error('Paper collection response did not include an uncertainty marker such as "待确认".');
  }

  return {
    hasQueryGroup,
    hasFilters,
    hasCandidates,
    hasReadingOrder,
    hasUnconfirmedMarker,
  };
}
