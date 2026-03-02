#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const catalogDir = path.join(repoRoot, 'reports', 'e2e', 'catalog');

const UI_SCOPE_FILES = [
  'src/App.tsx',
  'src/components/layout/Sidebar.tsx',
  'src/components/filetree/FileTree.tsx',
  'src/components/pane/PaneRenderer.tsx',
  'src/components/session/SessionView.tsx',
  'src/components/timeline/Timeline.tsx',
  'src/components/pdf/PDFViewer.tsx',
  'src/components/ui/PermissionToggle.tsx',
  'src/components/editor/RenderedDiffViewer.tsx',
  'src/components/editor/TiptapMarkdownEditor.tsx',
];

const FEATURE_BLUEPRINTS = [
  {
    feature_id: 'file.lifecycle',
    name: '文件域：上传/新建/移动/删除',
    risk: 'P0',
    owner: 'cross',
    routePatterns: [
      '/api/v1/files/upload',
      '/api/v1/files/folders',
      'POST /api/v1/files/{file_id}/move',
      'DELETE /api/v1/files/{file_id}',
      'GET /api/v1/files/',
      'GET /api/v1/files/{file_id}',
    ],
    toolNames: ['update_file', 'update_block', 'insert_block', 'delete_block'],
    uiPatterns: ['Explorer', 'New File', 'New Folder', 'Create', 'Add at current path', 'Refresh'],
  },
  {
    feature_id: 'pane.layout_and_tabs',
    name: 'Pane 域：分屏与 Tab 拖拽',
    risk: 'P0',
    owner: 'frontend',
    routePatterns: [],
    toolNames: [],
    uiPatterns: ['New Pane', 'Split Pane', 'Empty Pane'],
  },
  {
    feature_id: 'session.context_permissions',
    name: 'Session 域：权限与上下文过滤',
    risk: 'P0',
    owner: 'cross',
    routePatterns: [
      'POST /api/v1/chat/sessions',
      'GET /api/v1/chat/sessions',
      'POST /api/v1/chat/sessions/{session_id}/permissions',
      'PUT /api/v1/chat/sessions/{session_id}/permissions',
      'POST /api/v1/chat/completions',
    ],
    toolNames: [],
    uiPatterns: ['Context Files', 'Session References', 'Connected', 'Reconnecting', 'Connecting'],
  },
  {
    feature_id: 'agent.tools.read',
    name: 'Agent Tool 域：读取类工具',
    risk: 'P0',
    owner: 'backend',
    routePatterns: [
      'POST /api/v1/chat/completions',
      'GET /api/v1/files/{file_id}/segments',
      'GET /api/v1/files/{file_id}/chunks',
      'GET /api/v1/files/{file_id}/index-status',
    ],
    toolNames: [
      'locate_relevant_segments',
      'read_document_segments',
      'read_webpage_blocks',
      'get_document_outline',
      'explain_retrieval',
      'get_index_status',
    ],
    uiPatterns: ['Agent Tool Records', 'Calls', 'Results'],
  },
  {
    feature_id: 'agent.tools.write',
    name: 'Agent Tool 域：写入类工具',
    risk: 'P0',
    owner: 'cross',
    routePatterns: [
      'POST /api/v1/files/{file_id}/diff-events',
      'GET /api/v1/files/{file_id}/diff-events/pending',
      'PATCH /api/v1/files/{file_id}/diff-events/{event_id}/lines/{line_id}',
      'POST /api/v1/files/{file_id}/diff-events/{event_id}/finalize',
    ],
    toolNames: ['update_file', 'update_block', 'insert_block', 'delete_block', 'add_file_charts_to_note'],
    uiPatterns: ['Accept All', 'Reject All', 'Exit Diff'],
  },
  {
    feature_id: 'agent.tools.task_control',
    name: 'Agent Tool 域：任务与暂停控制',
    risk: 'P0',
    owner: 'cross',
    routePatterns: ['POST /api/v1/chat/tasks/{task_id}/cancel', 'POST /api/v1/chat/tasks/{task_id}/answer'],
    toolNames: ['register_task', 'deliver_task', 'pause_for_user_choice'],
    uiPatterns: ['Task running', 'Task paused', 'Continue Task', 'Cancel', 'Retry'],
  },
  {
    feature_id: 'diff.pending_review',
    name: 'Diff 域：逐行审阅与总量提交',
    risk: 'P0',
    owner: 'cross',
    routePatterns: [
      'GET /api/v1/files/{file_id}/diff-events/pending',
      'PATCH /api/v1/files/{file_id}/diff-events/{event_id}/lines/{line_id}',
      'POST /api/v1/files/{file_id}/diff-events/{event_id}/finalize',
    ],
    toolNames: ['update_file', 'update_block'],
    uiPatterns: ['Accept All', 'Reject All', 'pending line', 'Previous pending line', 'Next pending line'],
  },
  {
    feature_id: 'version.history_consistency',
    name: '版本域：历史一致性与回溯',
    risk: 'P0',
    owner: 'cross',
    routePatterns: ['GET /api/v1/files/{file_id}/versions'],
    toolNames: [],
    uiPatterns: ['Timeline', 'Refresh timeline', 'Exit Diff'],
  },
  {
    feature_id: 'viewport.context_tracking',
    name: '视口域：阅读位置上下文注入',
    risk: 'P0',
    owner: 'cross',
    routePatterns: [
      'POST /api/v1/viewport/update',
      'GET /api/v1/viewport/{session_id}',
      'DELETE /api/v1/viewport/{session_id}',
      'WEBSOCKET /ws/connect',
    ],
    toolNames: [],
    uiPatterns: ['pdf-toolbar', 'pdf-scroll-container', 'Previous page', 'Next page'],
  },
  {
    feature_id: 'stability.runtime_observability',
    name: '稳定性域：网络/控制台/WS 可观测',
    risk: 'P0',
    owner: 'cross',
    routePatterns: ['GET /health', 'GET /ws/status', 'WEBSOCKET /ws/connect'],
    toolNames: [],
    uiPatterns: ['Connected', 'Reconnecting', 'Connecting'],
  },
  {
    feature_id: 'editor.inline_math_enter',
    name: '编辑器：行内公式换行稳定性',
    risk: 'P1',
    owner: 'frontend',
    routePatterns: [],
    toolNames: [],
    uiPatterns: ['New File', 'Create'],
  },
  {
    feature_id: 'editor.block_math_render',
    name: '编辑器：块级公式即时渲染',
    risk: 'P1',
    owner: 'frontend',
    routePatterns: [],
    toolNames: [],
    uiPatterns: ['New File', 'Create'],
  },
  {
    feature_id: 'editor.copy_markdown',
    name: '编辑器：复制输出 Markdown 语义',
    risk: 'P1',
    owner: 'frontend',
    routePatterns: [],
    toolNames: [],
    uiPatterns: ['New File', 'Create'],
  },
  {
    feature_id: 'editor.reference_contextmenu',
    name: '编辑器：选区引用与临时对话流',
    risk: 'P1',
    owner: 'cross',
    routePatterns: ['POST /api/v1/chat/completions'],
    toolNames: [],
    uiPatterns: ['Session References', 'Remove reference'],
  },
  {
    feature_id: 'pdf.last_page_scroll',
    name: 'PDF：末页翻页不触发外层滚动跳跃',
    risk: 'P1',
    owner: 'frontend',
    routePatterns: ['POST /api/v1/files/upload'],
    toolNames: [],
    uiPatterns: ['Next page', 'pdf-scroll-container', 'pdf-toolbar'],
  },
  {
    feature_id: 'theme.newspaper_baseline',
    name: '视觉主题：newspaper 基线契约',
    risk: 'P2',
    owner: 'frontend',
    routePatterns: [],
    toolNames: [],
    uiPatterns: ['Light newspaper mode is fixed in this build', 'Timeline', 'Explorer'],
  },
];

const FEATURE_TARGET_MAP = {
  'file.lifecycle': 'full_flow_audit',
  'pane.layout_and_tabs': 'full_flow_audit',
  'session.context_permissions': 'full_flow_audit',
  'agent.tools.read': 'full_flow_audit',
  'agent.tools.write': 'full_flow_audit',
  'agent.tools.task_control': 'full_flow_audit',
  'diff.pending_review': 'full_flow_audit',
  'version.history_consistency': 'full_flow_audit',
  'viewport.context_tracking': 'full_flow_audit',
  'stability.runtime_observability': 'full_flow_audit',
  'editor.inline_math_enter': 'inline_math_enter',
  'editor.block_math_render': 'block_math_immediate_render',
  'editor.copy_markdown': 'editor_copy_markdown',
  'editor.reference_contextmenu': 'editor_reference_contextmenu',
  'pdf.last_page_scroll': 'pdf_last_page_scroll',
  'theme.newspaper_baseline': 'newspaper_theme_baseline',
};

const EXECUTION_TARGETS = [
  {
    id: 'full_flow_audit',
    name: 'Full flow audit (real llm)',
    description: '8-step full workflow with task/diff/version checks in real-llm mode.',
    spec: 'e2e-tests/full-flow-audit.spec.ts',
    grep: 'knowledgeide full user flow audit',
    llm_mode: 'real',
    browser: 'chromium-desktop',
  },
  {
    id: 'inline_math_enter',
    name: 'Inline math enter regression',
    description: 'Inline math newline behavior regression coverage.',
    spec: 'e2e-tests/inline-math-enter.spec.ts',
    llm_mode: 'real',
    browser: 'chromium-desktop',
  },
  {
    id: 'block_math_immediate_render',
    name: 'Block math immediate render regression',
    description: 'Block-math immediate rendering and post-edit stability coverage.',
    spec: 'e2e-tests/block-math-immediate-render.spec.ts',
    llm_mode: 'real',
    browser: 'chromium-desktop',
  },
  {
    id: 'editor_copy_markdown',
    name: 'Editor copy markdown regression',
    description: 'Copy should preserve markdown instead of html wrappers.',
    spec: 'e2e-tests/editor-copy-markdown.spec.ts',
    llm_mode: 'real',
    browser: 'chromium-desktop',
  },
  {
    id: 'editor_reference_contextmenu',
    name: 'Editor reference context menu regression',
    description: 'Context menu reference import and temporary dialog coverage.',
    spec: 'e2e-tests/editor-reference-contextmenu.spec.ts',
    llm_mode: 'real',
    browser: 'chromium-desktop',
  },
  {
    id: 'pdf_last_page_scroll',
    name: 'PDF last page scroll regression',
    description: 'Paging to last page should not cause outer-page jump.',
    spec: 'e2e-tests/pdf-last-page-scroll.spec.ts',
    llm_mode: 'real',
    browser: 'chromium-desktop',
  },
  {
    id: 'newspaper_theme_baseline',
    name: 'Newspaper theme baseline',
    description: 'Theme CSS variable and baseline UI contract checks.',
    spec: 'e2e-tests/newspaper-theme.spec.ts',
    llm_mode: 'real',
    browser: 'chromium-desktop',
  },
  {
    id: 'catalog_integrity',
    name: 'Catalog integrity guard',
    description: 'Validate feature/path/source completeness in generated catalog.',
    spec: 'e2e-tests/specs/catalog-integrity.spec.ts',
    grep: 'catalog integrity',
    llm_mode: 'real',
    browser: 'chromium-desktop',
  },
];

const DEFAULT_EVIDENCE = ['screenshot', 'trace', 'video', 'network', 'console'];

function nowIso() {
  return new Date().toISOString();
}

function walkFiles(dirPath, predicate = () => true) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, predicate));
      continue;
    }
    if (predicate(fullPath)) results.push(fullPath);
  }
  return results;
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function normalizeUrlPath(...segments) {
  const cleaned = [];
  for (const segment of segments) {
    if (!segment) continue;
    const str = String(segment).trim();
    if (!str) continue;
    if (str === '/') continue;
    cleaned.push(str.replace(/^\/+/, '').replace(/\/+$/, ''));
  }
  if (!cleaned.length) return '/';
  return `/${cleaned.join('/')}`.replace(/\/+/g, '/');
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseApiPrefix(configText) {
  const match = configText.match(/API_V1_PREFIX\s*:\s*str\s*=\s*["']([^"']+)["']/);
  return match?.[1] || '/api/v1';
}

function parseMainRouterPrefixes(mainText, apiPrefix) {
  const result = {};
  const includeRegex = /app\.include_router\(\s*([A-Za-z_][A-Za-z0-9_]*)\.router(?:\s*,\s*prefix\s*=\s*([^\)]+))?\s*\)/g;
  let match;
  while ((match = includeRegex.exec(mainText)) !== null) {
    const moduleAlias = match[1];
    const prefixExpr = (match[2] || '').trim();
    let resolved = '';

    if (!prefixExpr) {
      resolved = '';
    } else if (prefixExpr.includes('settings.API_V1_PREFIX')) {
      resolved = apiPrefix;
    } else {
      const literal = prefixExpr.match(/["']([^"']+)["']/);
      if (literal) resolved = literal[1];
    }

    result[moduleAlias] = resolved;
  }

  return result;
}

function extractRoutes({ apiPrefix, routerPrefixesByModule }) {
  const apiDir = path.join(repoRoot, 'backend', 'app', 'api');
  const files = walkFiles(apiDir, (filePath) => filePath.endsWith('.py') && !filePath.endsWith('__init__.py'));
  const routes = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(repoRoot, filePath).replaceAll('\\', '/');
    const moduleName = path.basename(filePath, '.py');
    const routerPrefixMatch = content.match(/APIRouter\(\s*prefix\s*=\s*["']([^"']+)["']/);
    const routerPrefix = routerPrefixMatch?.[1] || '';
    const mountPrefix = routerPrefixesByModule[moduleName] || '';
    const tagsMatch = content.match(/APIRouter\([\s\S]*?tags\s*=\s*\[([^\]]*)\]/);
    const tags = [];

    if (tagsMatch?.[1]) {
      const tagRegex = /["']([^"']+)["']/g;
      let tagMatch;
      while ((tagMatch = tagRegex.exec(tagsMatch[1])) !== null) {
        tags.push(tagMatch[1]);
      }
    }

    const decoratorRegex = /@router\.(get|post|put|patch|delete|websocket)\(\s*["']([^"']*)["']/g;
    let match;
    while ((match = decoratorRegex.exec(content)) !== null) {
      const methodRaw = match[1];
      const method = methodRaw === 'websocket' ? 'WEBSOCKET' : methodRaw.toUpperCase();
      const endpointPath = match[2] || '/';
      const functionBlock = content.slice(match.index + match[0].length);
      const functionMatch = functionBlock.match(/\n\s*(?:async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      const functionName = functionMatch?.[1] || 'unknown';

      const fullPath = normalizeUrlPath(mountPrefix, routerPrefix, endpointPath);
      routes.push({
        route_key: `${method} ${fullPath}`,
        method,
        path: fullPath,
        module: moduleName,
        file: relativePath,
        function: functionName,
        decorator_path: endpointPath,
        router_prefix: routerPrefix || '/',
        mount_prefix: mountPrefix || '/',
        tags,
        line: lineNumberAt(content, match.index),
      });
    }
  }

  const mainPath = path.join(repoRoot, 'backend', 'main.py');
  if (fs.existsSync(mainPath)) {
    const mainContent = fs.readFileSync(mainPath, 'utf-8');
    const decoratorRegex = /@app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;
    let match;
    while ((match = decoratorRegex.exec(mainContent)) !== null) {
      const method = match[1].toUpperCase();
      const endpointPath = match[2] || '/';
      const functionBlock = mainContent.slice(match.index + match[0].length);
      const functionMatch = functionBlock.match(/\n\s*(?:async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      const functionName = functionMatch?.[1] || 'unknown';
      const normalizedPath = normalizeUrlPath(endpointPath);
      routes.push({
        route_key: `${method} ${normalizedPath}`,
        method,
        path: normalizedPath,
        module: 'main',
        file: 'backend/main.py',
        function: functionName,
        decorator_path: endpointPath,
        router_prefix: '/',
        mount_prefix: '/',
        tags: ['root'],
        line: lineNumberAt(mainContent, match.index),
      });
    }
  }

  routes.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.method.localeCompare(b.method);
  });

  return {
    generated_at: nowIso(),
    api_prefix: apiPrefix,
    total_routes: routes.length,
    routes,
  };
}

function inferActionKind(toolName) {
  if (
    [
      'locate_relevant_segments',
      'read_document_segments',
      'get_document_outline',
      'read_webpage_blocks',
      'explain_retrieval',
      'get_index_status',
    ].includes(toolName)
  ) {
    return 'read';
  }
  if (['insert_block', 'add_file_charts_to_note'].includes(toolName)) return 'create';
  if (['update_file', 'update_block'].includes(toolName)) return 'update';
  if (toolName === 'delete_block') return 'delete';
  if (['pause_for_user_choice'].includes(toolName)) return 'pause';
  if (['register_task', 'deliver_task'].includes(toolName)) return 'task';
  return 'other';
}

function extractToolClasses() {
  const handlersDir = path.join(repoRoot, 'backend', 'app', 'services', 'tools', 'handlers');
  const files = walkFiles(handlersDir, (filePath) => filePath.endsWith('.py') && !filePath.endsWith('__init__.py'));
  const classMap = new Map();

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const classRegex = /class\s+([A-Za-z_][A-Za-z0-9_]*)\(BaseTool\):/g;
    const classMatches = [];
    let match;

    while ((match = classRegex.exec(content)) !== null) {
      classMatches.push({ className: match[1], index: match.index });
    }

    for (let i = 0; i < classMatches.length; i += 1) {
      const current = classMatches[i];
      const next = classMatches[i + 1];
      const block = content.slice(current.index, next ? next.index : content.length);

      const nameMatch = block.match(/def\s+name\(self\)\s*->\s*str:[\s\S]*?return\s+["']([^"']+)["']/);
      const descriptionMatch = block.match(/def\s+description\(self\)\s*->\s*str:[\s\S]*?return\s+["']([^"']+)["']/);
      const permissionMatch = block.match(/def\s+required_permission\(self\)\s*->\s*PermissionLevel:[\s\S]*?return\s+PermissionLevel\.([A-Z_]+)/);
      const requiredMatch = block.match(/["']required["']\s*:\s*\[([^\]]*)\]/);

      const required = [];
      if (requiredMatch?.[1]) {
        const itemRegex = /["']([^"']+)["']/g;
        let item;
        while ((item = itemRegex.exec(requiredMatch[1])) !== null) {
          required.push(item[1]);
        }
      }

      classMap.set(current.className, {
        className: current.className,
        file: path.relative(repoRoot, filePath).replaceAll('\\', '/'),
        line: lineNumberAt(content, current.index),
        name: nameMatch?.[1] || current.className.replace(/Tool$/, '').toLowerCase(),
        description: descriptionMatch?.[1] || '',
        required_permission: permissionMatch ? permissionMatch[1].toLowerCase() : 'none',
        parameters_required: required,
      });
    }
  }

  return classMap;
}

function extractTools() {
  const initPath = path.join(repoRoot, 'backend', 'app', 'services', 'tools', 'handlers', '__init__.py');
  const initText = fs.readFileSync(initPath, 'utf-8');
  const registerBlockMatch = initText.match(/register_tools\(([\s\S]*?)\)\s*\n/);

  if (!registerBlockMatch) {
    throw new Error('Could not locate register_tools(...) block in backend/app/services/tools/handlers/__init__.py');
  }

  const classNames = [];
  const classRegex = /([A-Za-z_][A-Za-z0-9_]*Tool)\(\)/g;
  let match;
  while ((match = classRegex.exec(registerBlockMatch[1])) !== null) {
    classNames.push(match[1]);
  }

  const classMap = extractToolClasses();
  const tools = [];

  for (const className of classNames) {
    const classInfo = classMap.get(className);
    const toolName = classInfo?.name || className.replace(/Tool$/, '').toLowerCase();

    tools.push({
      tool_key: toolName,
      name: toolName,
      class_name: className,
      description: classInfo?.description || '',
      required_permission: classInfo?.required_permission || 'none',
      action_kind: inferActionKind(toolName),
      parameters_required: classInfo?.parameters_required || [],
      file: classInfo?.file || 'backend/app/services/tools/handlers/__init__.py',
      line: classInfo?.line || 1,
    });
  }

  return {
    generated_at: nowIso(),
    total_tools: tools.length,
    tools,
  };
}

function stripJsx(text) {
  return text
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUiTree() {
  const components = [];
  const uiNodes = [];

  for (const relativeFile of UI_SCOPE_FILES) {
    const filePath = path.join(repoRoot, relativeFile);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const componentName = path.basename(relativeFile, path.extname(relativeFile));
    const componentId = relativeFile.replaceAll('/', '.').replaceAll('.tsx', '');
    const nodes = [];

    const attrPatterns = [
      ['title', /title\s*=\s*["']([^"']+)["']/g],
      ['aria-label', /aria-label\s*=\s*["']([^"']+)["']/g],
      ['placeholder', /placeholder\s*=\s*["']([^"']+)["']/g],
      ['data-testid', /data-testid\s*=\s*["']([^"']+)["']/g],
    ];

    for (const [kind, regex] of attrPatterns) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        nodes.push({ kind, value: match[1], line: lineNumberAt(content, match.index) });
      }
    }

    const buttonRegex = /<button[^>]*>([\s\S]*?)<\/button>/g;
    let buttonMatch;
    while ((buttonMatch = buttonRegex.exec(content)) !== null) {
      const value = stripJsx(buttonMatch[1]);
      if (value && value.length <= 80) {
        nodes.push({ kind: 'button-text', value, line: lineNumberAt(content, buttonMatch.index) });
      }
    }

    const configLiteralRegex = /(title|label)\s*:\s*["']([^"']+)["']/g;
    let literalMatch;
    while ((literalMatch = configLiteralRegex.exec(content)) !== null) {
      nodes.push({ kind: `config-${literalMatch[1]}`, value: literalMatch[2], line: lineNumberAt(content, literalMatch.index) });
    }

    const quickTextRegex = />\s*(Explorer|Timeline|Context Files|Session References|Accept All|Reject All|Exit Diff|New Pane|Empty Pane|Connected|Reconnecting|Connecting\.\.\.)\s*</g;
    let quickMatch;
    while ((quickMatch = quickTextRegex.exec(content)) !== null) {
      nodes.push({ kind: 'text', value: quickMatch[1], line: lineNumberAt(content, quickMatch.index) });
    }

    const dedupedMap = new Map();
    for (const node of nodes) {
      const key = `${node.kind}::${node.value}`;
      if (!dedupedMap.has(key)) {
        const id = `${componentId}:${node.kind}:${slug(node.value)}`;
        dedupedMap.set(key, {
          id,
          component_id: componentId,
          component_name: componentName,
          file: relativeFile,
          kind: node.kind,
          value: node.value,
          line: node.line,
        });
      }
    }

    const dedupedNodes = [...dedupedMap.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.value.localeCompare(b.value);
    });

    components.push({
      component_id: componentId,
      component_name: componentName,
      file: relativeFile,
      node_count: dedupedNodes.length,
      nodes: dedupedNodes,
    });

    uiNodes.push(...dedupedNodes);
  }

  components.sort((a, b) => a.file.localeCompare(b.file));
  uiNodes.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.value.localeCompare(b.value);
  });

  return {
    generated_at: nowIso(),
    total_components: components.length,
    total_nodes: uiNodes.length,
    components,
    ui_nodes: uiNodes,
  };
}

function pickRoutes(routes, patterns) {
  if (!patterns?.length) return [];
  const picked = routes.filter((route) =>
    patterns.some((pattern) => route.route_key.includes(pattern) || route.path.includes(pattern))
  );
  return [...new Set(picked.map((item) => item.route_key))];
}

function pickTools(tools, names) {
  if (!names?.length) return [];
  const selected = tools.filter((tool) => names.includes(tool.name));
  return [...new Set(selected.map((tool) => tool.name))];
}

function pickUiNodes(uiNodes, patterns) {
  if (!patterns?.length) return [];
  const selected = uiNodes.filter((node) =>
    patterns.some((pattern) => node.value.includes(pattern) || node.id.includes(slug(pattern)))
  );
  return [...new Set(selected.map((node) => node.id))];
}

function gateLevelFromRisk(risk) {
  return risk === 'P0' ? 'blocking' : 'warning';
}

function buildFeaturesAndPaths({ routeCatalog, toolCatalog, uiCatalog }) {
  const routes = routeCatalog.routes;
  const tools = toolCatalog.tools;
  const uiNodes = uiCatalog.ui_nodes;

  const features = FEATURE_BLUEPRINTS.map((blueprint) => {
    const sourceRoutes = pickRoutes(routes, blueprint.routePatterns);
    const sourceTools = pickTools(tools, blueprint.toolNames);
    const sourceUiNodes = pickUiNodes(uiNodes, blueprint.uiPatterns);

    return {
      feature_id: blueprint.feature_id,
      name: blueprint.name,
      source_routes: sourceRoutes,
      source_tools: sourceTools,
      source_ui_nodes: sourceUiNodes,
      risk: blueprint.risk,
      owner: blueprint.owner,
    };
  });

  const assignedRoutes = new Set(features.flatMap((feature) => feature.source_routes));
  const assignedTools = new Set(features.flatMap((feature) => feature.source_tools));
  const assignedUiNodes = new Set(features.flatMap((feature) => feature.source_ui_nodes));

  const missingRoutes = routes.map((route) => route.route_key).filter((routeKey) => !assignedRoutes.has(routeKey));
  const missingTools = tools.map((tool) => tool.name).filter((toolName) => !assignedTools.has(toolName));
  const missingUiNodes = uiNodes.map((node) => node.id).filter((nodeId) => !assignedUiNodes.has(nodeId));

  if (missingRoutes.length) {
    features.push({
      feature_id: 'coverage.unmapped.routes',
      name: '覆盖兜底：未映射 API 路由',
      source_routes: missingRoutes,
      source_tools: [],
      source_ui_nodes: [],
      risk: 'P2',
      owner: 'backend',
    });
  }

  if (missingTools.length) {
    features.push({
      feature_id: 'coverage.unmapped.tools',
      name: '覆盖兜底：未映射 Agent Tools',
      source_routes: [],
      source_tools: missingTools,
      source_ui_nodes: [],
      risk: 'P2',
      owner: 'backend',
    });
  }

  if (missingUiNodes.length) {
    features.push({
      feature_id: 'coverage.unmapped.ui',
      name: '覆盖兜底：未映射 UI 树节点',
      source_routes: [],
      source_tools: [],
      source_ui_nodes: missingUiNodes,
      risk: 'P2',
      owner: 'frontend',
    });
  }

  const paths = features.map((feature) => {
    const pathId = `${feature.feature_id}.path.primary`;
    const executionTarget = FEATURE_TARGET_MAP[feature.feature_id] || 'catalog_integrity';
    const selectors = feature.source_ui_nodes.slice(0, 5);

    return {
      path_id: pathId,
      feature_id: feature.feature_id,
      preconditions: [
        'Backend /health is reachable.',
        'Frontend baseURL is reachable.',
        'Real LLM credentials are configured.',
      ],
      steps: [
        `Run execution target: ${executionTarget}.`,
        'Observe tool/task/network/console artifacts.',
        'Record pass/fail/flaky and evidence links.',
      ],
      expected: [
        'No blocker failure on P0 path.',
        'Evidence includes screenshot/trace/video/network/console.',
        'Path result is attributable to a concrete execution target.',
      ],
      selectors,
      evidence: DEFAULT_EVIDENCE,
      gate_level: gateLevelFromRisk(feature.risk),
      execution_target: executionTarget,
    };
  });

  return {
    featureCatalog: {
      generated_at: nowIso(),
      total_features: features.length,
      features,
    },
    testPathCatalog: {
      generated_at: nowIso(),
      total_paths: paths.length,
      execution_targets: EXECUTION_TARGETS,
      paths,
    },
  };
}

async function writeJson(fileName, payload) {
  const fullPath = path.join(catalogDir, fileName);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

async function main() {
  const configPath = path.join(repoRoot, 'backend', 'app', 'config.py');
  const mainPath = path.join(repoRoot, 'backend', 'main.py');
  if (!fs.existsSync(configPath) || !fs.existsSync(mainPath)) {
    throw new Error('backend/app/config.py or backend/main.py is missing.');
  }

  const configText = await fsp.readFile(configPath, 'utf-8');
  const mainText = await fsp.readFile(mainPath, 'utf-8');
  const apiPrefix = parseApiPrefix(configText);
  const routerPrefixesByModule = parseMainRouterPrefixes(mainText, apiPrefix);

  const routeCatalog = extractRoutes({ apiPrefix, routerPrefixesByModule });
  const toolCatalog = extractTools();
  const uiCatalog = extractUiTree();
  const { featureCatalog, testPathCatalog } = buildFeaturesAndPaths({
    routeCatalog,
    toolCatalog,
    uiCatalog,
  });

  await writeJson('routes.json', routeCatalog);
  await writeJson('tools.json', toolCatalog);
  await writeJson('ui-tree.json', uiCatalog);
  await writeJson('features.json', featureCatalog);
  await writeJson('test-paths.json', testPathCatalog);

  console.log(`[catalog] written to ${path.relative(repoRoot, catalogDir).replaceAll('\\', '/')}`);
  console.log(`[catalog] routes=${routeCatalog.total_routes}, tools=${toolCatalog.total_tools}, ui_nodes=${uiCatalog.total_nodes}`);
  console.log(`[catalog] features=${featureCatalog.total_features}, test_paths=${testPathCatalog.total_paths}`);
}

await main();
