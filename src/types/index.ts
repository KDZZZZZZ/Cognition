// Core Types
export type FileType = 'folder' | 'md' | 'pdf' | 'code' | 'session' | 'image';

export type Permission = 'read' | 'write' | 'none';

export type ViewMode = 'editor' | 'diff' | 'preview';

export type Author = 'human' | 'agent';

// File System
export interface FileNode {
  id: string;
  name: string;
  type: FileType;
  isOpen?: boolean;
  children?: FileNode[];
  mode?: ViewMode;
}

export interface VirtualFile {
  id: string;
  name: string;
  type: FileType;
  content: string;
  version: number;
  permissions: Record<string, Permission>;
  viewportState?: ViewportState;
}

export interface ViewportState {
  currentPage: number;
  visibleTextRange: [number, number];
}

// Pane System
export interface Tab {
  id: string;
  name: string;
  type: FileType;
  mode: ViewMode;
}

export interface Pane {
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
}

// Session & Permissions
export interface SessionPermissions {
  [sessionId: string]: Record<string, Permission>;
}

// Version Control
export interface VersionNode {
  id: string;
  fileId: string;
  timestamp: number;
  author: Author;
  changeType: 'edit' | 'refactor' | 'delete' | 'create';
  summary: string;
  diffPatch?: string;
  contextSnapshot?: string;
}

export interface Timeline {
  [fileId: string]: VersionNode[];
}

// Diff View
export interface DiffLine {
  line: number;
  content: string;
  type: 'normal' | 'add' | 'remove';
}

export type DiffEventStatus = 'pending' | 'resolved';
export type LineDecision = 'pending' | 'accepted' | 'rejected';

export interface DiffLineDTO {
  id: string;
  line_no: number;
  old_line: string | null;
  new_line: string | null;
  decision: LineDecision;
}

export interface DiffEventDTO {
  id: string;
  file_id: string;
  author: Author;
  summary?: string;
  status: DiffEventStatus;
  old_content: string;
  new_content: string;
  created_at: string;
  resolved_at?: string | null;
  lines: DiffLineDTO[];
}

// Context Menu
export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  file: FileNode | null;
}

  // UI State
export type Theme = 'light' | 'dark';

export interface UIState {
  theme: Theme;
  sidebarOpen: boolean;
  activePaneId: string | null;
  timelineExpanded: boolean;
  contextMenu: ContextMenuState;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setActivePane: (paneId: string | null) => void;
  toggleTimeline: () => void;
  showContextMenu: (x: number, y: number, file: FileNode | null) => void;
  hideContextMenu: () => void;
}
