import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Folder, 
  FileText, 
  FileCode, 
  MessageSquare, 
  Search, 
  Plus, 
  Menu, 
  X, 
  ChevronRight, 
  ChevronDown,
  Download,
  History,
  Trash2,
  Edit2,
  File as FileIcon,
  Maximize2,
  Split,
  Eye,
  EyeOff,
  Pencil,
  GitCommit,
  Clock,
  Send,
  Bot
} from 'lucide-react';

// --- MOCK DATA ---

const MOCK_MD_CONTENT = `# Project Notes

## 1. Introduction
This is a **Typora-style** demo. 
Click a specific line to edit it. Other lines remain rendered.

## 2. Features
- [x] Block-based Editing
- [x] Rendered Diff
- [ ] Cloud Sync

> "Simplicity is the soul of efficiency."

\`\`\`javascript
console.log("Only the active line shows raw code.");
\`\`\`
`;

const INITIAL_FILE_TREE = [
  { 
    id: 'f1', 
    name: 'src', 
    type: 'folder', 
    isOpen: true, 
    children: [
      { id: 'd10', name: 'utils.py', type: 'code' },
      { id: 'd11', name: 'config.json', type: 'code' }
    ] 
  },
  { 
    id: 'f2', 
    name: 'assets', 
    type: 'folder', 
    isOpen: false, 
    children: [
       { id: 'd12', name: 'logo.png', type: 'image' }
    ] 
  },
  { id: 'd1', name: 'whitepaper.pdf', type: 'pdf' },
  { id: 'd2', name: 'note.md', type: 'md' },
  { id: 's1', name: 'Project Discussion', type: 'session' },
];

// Timeline Data
const FILE_TIMELINE = {
  'd2': [
    { id: 'v3', date: 'Just now', author: 'You', message: 'Update project features', type: 'current' },
    { id: 'v2', date: '2 hours ago', author: 'AI Assistant', message: 'Refactor lists', type: 'history' },
  ]
};

// Diff Data (Raw content to be rendered)
const CODE_DIFF_DATA = [
  { line: 1, content: '# Project Notes', type: 'normal' },
  { line: 2, content: '', type: 'normal' },
  { line: 3, content: '## 1. Introduction', type: 'normal' },
  { line: 4, content: 'Old plain text introduction.', type: 'remove' },
  { line: 5, content: '**New Typora Style** Introduction.', type: 'add' },
  { line: 6, content: '', type: 'normal' },
  { line: 7, content: '- [ ] Old Task', type: 'remove' },
  { line: 8, content: '- [x] New Task', type: 'add' },
];

// --- COMPONENTS ---

// 1. Single Line Markdown Renderer
const RenderLine = ({ content }) => {
  if (!content) return <div className="h-6"></div>; // Empty line placeholder

  // Headers
  if (content.startsWith('# ')) return <h1 className="text-3xl font-bold text-gray-900 mt-2 mb-2">{content.replace('# ', '')}</h1>;
  if (content.startsWith('## ')) return <h2 className="text-2xl font-semibold text-gray-800 mt-2 mb-2 pb-1 border-b border-gray-200">{content.replace('## ', '')}</h2>;
  
  // Blockquotes
  if (content.startsWith('> ')) return <blockquote className="border-l-4 border-blue-400 pl-4 py-1 my-1 bg-blue-50 italic text-gray-600">{content.replace('> ', '')}</blockquote>;
  
  // Code Blocks (Simplified for single line view)
  if (content.trim().startsWith('```')) return <div className="font-mono text-gray-400 text-xs">{content}</div>;
  
  // Lists
  if (content.trim().startsWith('- [ ]')) return <div className="flex items-center gap-2 my-1"><input type="checkbox" readOnly className="rounded" /> <span>{parseBold(content.replace('- [ ]', ''))}</span></div>;
  if (content.trim().startsWith('- [x]')) return <div className="flex items-center gap-2 my-1"><input type="checkbox" checked readOnly className="rounded" /> <span className="line-through text-gray-400">{parseBold(content.replace('- [x]', ''))}</span></div>;
  if (content.trim().startsWith('- ')) return <li className="ml-4 list-disc">{parseBold(content.replace('- ', ''))}</li>;

  // Regular Paragraph with Bold Parsing
  return <p className="leading-relaxed min-h-[1.5em]">{parseBold(content)}</p>;
};

// Helper to parse **bold** inside string
const parseBold = (text) => {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
};

// 2. Permission Toggle
const PermissionToggle = ({ status, onClick }) => {
  const getIcon = () => {
    switch(status) {
      case 'read': return <Eye size={14} className="text-blue-500" />;
      case 'write': return <Pencil size={14} className="text-green-500" />;
      case 'none': return <EyeOff size={14} className="text-gray-400" />;
      default: return <Eye size={14} className="text-blue-500" />;
    }
  };
  return (
    <button onClick={onClick} className="p-1.5 rounded hover:bg-gray-200 transition-colors flex items-center gap-1 bg-gray-50 border border-gray-200">
      {getIcon()}
    </button>
  );
};

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [fileTree, setFileTree] = useState(INITIAL_FILE_TREE);
  
  // Panes
  const [panes, setPanes] = useState([{ id: 'default', tabs: [], activeTabId: null }]);
  const [activePaneId, setActivePaneId] = useState('default');
  
  // Content State
  const [fileContents, setFileContents] = useState({ 'd2': MOCK_MD_CONTENT });
  const [sessionPermissions, setSessionPermissions] = useState({});

  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, file: null });
  const [timelineExpanded, setTimelineExpanded] = useState(true);

  // Derived state
  const allOpenFiles = useMemo(() => {
    const filesMap = new Map();
    panes.forEach(pane => pane.tabs.forEach(tab => filesMap.set(tab.id, tab)));
    return Array.from(filesMap.values());
  }, [panes]);

  const activeFileId = panes.find(p => p.id === activePaneId)?.activeTabId;
  const activeTimeline = activeFileId && FILE_TIMELINE[activeFileId] ? FILE_TIMELINE[activeFileId] : [];

  // --- ACTIONS ---
  
  const updateFileContent = (fileId, newContent) => {
    setFileContents(prev => ({ ...prev, [fileId]: newContent }));
  };

  const togglePermission = (sessionId, fileId) => {
    setSessionPermissions(prev => {
      const sessionData = prev[sessionId] || {};
      const current = sessionData[fileId] || 'read';
      const next = current === 'read' ? 'write' : current === 'write' ? 'none' : 'read';
      return { ...prev, [sessionId]: { ...sessionData, [fileId]: next } };
    });
  };

  const handleDragStart = (e, file) => {
    e.dataTransfer.setData('application/json', JSON.stringify(file));
  };

  const handleDrop = (e, paneId) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('application/json');
    if (data) {
      try {
        const file = JSON.parse(data);
        if (file.type === 'folder') return;
        openFileInPane(paneId, file);
      } catch (err) {}
    }
  };

  const openFileInPane = (paneId, file, mode = 'editor') => {
    setPanes(prevPanes => prevPanes.map(pane => {
      if (pane.id !== paneId) return pane;
      const existingTab = pane.tabs.find(t => t.id === file.id);
      if (existingTab) {
        if (existingTab.mode !== mode) {
           const updated = pane.tabs.map(t => t.id === file.id ? { ...t, mode } : t);
           return { ...pane, tabs: updated, activeTabId: file.id };
        }
        return { ...pane, activeTabId: file.id };
      }
      return { ...pane, tabs: [...pane.tabs, { ...file, mode }], activeTabId: file.id };
    }));
    setActivePaneId(paneId);
  };

  const openFileInActivePane = (file, mode = 'editor') => {
    if (!activePaneId) return;
    openFileInPane(activePaneId, file, mode);
  };

  const createNewPane = () => {
    const newPaneId = Date.now().toString();
    setPanes([...panes, { id: newPaneId, tabs: [], activeTabId: null }]);
    setActivePaneId(newPaneId);
  };

  const closeTab = (e, paneId, tabId) => {
    e.stopPropagation();
    setPanes(prevPanes => prevPanes.map(pane => {
      if (pane.id !== paneId) return pane;
      const newTabs = pane.tabs.filter(t => t.id !== tabId);
      const newActiveId = pane.activeTabId === tabId ? (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null) : pane.activeTabId;
      return { ...pane, tabs: newTabs, activeTabId: newActiveId };
    }));
  };

  const closePane = (e, id) => {
    e.stopPropagation();
    if (panes.length === 1) { setPanes([{ id: panes[0].id, tabs: [], activeTabId: null }]); return; }
    const newPanes = panes.filter(p => p.id !== id);
    setPanes(newPanes);
    if (activePaneId === id && newPanes.length > 0) setActivePaneId(newPanes[newPanes.length - 1].id);
  };

  // --- TIMELINE CLICK HANDLER ---
  const handleTimelineClick = (fileId) => {
    // Find the file metadata from the tree (simplified lookup)
    const findFile = (nodes) => {
        for(let node of nodes) {
            if(node.id === fileId) return node;
            if(node.children) {
                const found = findFile(node.children);
                if(found) return found;
            }
        }
        return null;
    };
    const file = findFile(INITIAL_FILE_TREE);
    if(file) openFileInActivePane(file, 'diff');
  };

  // --- TYPORA BLOCK EDITOR ---
  const TyporaBlockEditor = ({ content, onChange }) => {
    const lines = content.split('\n');
    const [focusedIndex, setFocusedIndex] = useState(null);
    const inputRefs = useRef([]);

    const handleLineChange = (index, newVal) => {
        const newLines = [...lines];
        newLines[index] = newVal;
        onChange(newLines.join('\n'));
    };

    const handleKeyDown = (e, index) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const newLines = [...lines];
            newLines.splice(index + 1, 0, ''); // Insert new line
            onChange(newLines.join('\n'));
            setTimeout(() => setFocusedIndex(index + 1), 0); // Focus next line
        }
        if (e.key === 'Backspace' && lines[index] === '' && index > 0) {
            e.preventDefault();
            const newLines = [...lines];
            newLines.splice(index, 1); // Delete current line
            onChange(newLines.join('\n'));
            setTimeout(() => setFocusedIndex(index - 1), 0); // Focus prev line
        }
    };

    return (
      <div className="w-full h-full p-8 overflow-y-auto bg-white" onClick={() => {
          if (focusedIndex === null && lines.length === 0) {
              onChange(''); // Ensure content exists
              setFocusedIndex(0);
          }
      }}>
        {lines.map((line, index) => (
            <div key={index} className="min-h-[28px] relative group">
                {focusedIndex === index ? (
                    <input
                        ref={el => inputRefs.current[index] = el}
                        autoFocus
                        className="w-full font-mono text-sm outline-none bg-blue-50/50 p-1 rounded"
                        value={line}
                        onChange={(e) => handleLineChange(index, e.target.value)}
                        onBlur={() => setFocusedIndex(null)}
                        onKeyDown={(e) => handleKeyDown(e, index)}
                        placeholder="Type markdown..."
                    />
                ) : (
                    <div 
                        onClick={(e) => { e.stopPropagation(); setFocusedIndex(index); }}
                        className="cursor-text hover:bg-gray-50 px-1 rounded -ml-1 transition-colors"
                    >
                        <RenderLine content={line} />
                    </div>
                )}
            </div>
        ))}
        {/* Clickable area at bottom to add new line */}
        <div 
            className="flex-1 min-h-[100px] cursor-text" 
            onClick={() => {
                const newLines = [...lines, ''];
                onChange(newLines.join('\n'));
                setFocusedIndex(newLines.length - 1);
            }}
        />
      </div>
    );
  };

  // --- RENDERERS ---

  const renderIcon = (type) => {
    switch (type) {
      case 'folder': return <Folder size={16} className="text-gray-500" />;
      case 'pdf': return <FileText size={16} className="text-red-400" />;
      case 'md': return <FileCode size={16} className="text-blue-400" />;
      case 'session': return <MessageSquare size={16} className="text-purple-400" />;
      case 'code': return <FileIcon size={16} className="text-yellow-500" />;
      default: return <FileText size={16} />;
    }
  };

  const FileTreeItem = ({ item, depth = 0 }) => (
    <div draggable={item.type !== 'folder'} onDragStart={(e) => handleDragStart(e, item)}>
      <div 
        className={`flex items-center gap-2 py-1.5 cursor-pointer text-sm hover:bg-gray-100 select-none ${activeFileId === item.id ? 'bg-blue-100 text-blue-700' : 'text-gray-700'}`}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        onClick={() => item.type === 'folder' ? setFileTree(prev => {
            const toggle = (nodes) => nodes.map(n => n.id === item.id ? { ...n, isOpen: !n.isOpen } : (n.children ? { ...n, children: toggle(n.children) } : n));
            return toggle(prev);
        }) : openFileInActivePane(item)}
      >
        <span className="text-gray-400 flex-shrink-0">
          {item.type === 'folder' && (item.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
          {item.type !== 'folder' && <div className="w-[14px]" />}
        </span>
        {renderIcon(item.type)}
        <span className="truncate">{item.name}</span>
      </div>
      {item.type === 'folder' && item.isOpen && item.children && (
        <div>{item.children.map(child => <FileTreeItem key={child.id} item={child} depth={depth + 1} />)}</div>
      )}
    </div>
  );

  const SessionView = ({ allFiles, permissions, onTogglePermission }) => (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-4 py-3 shadow-sm z-10">
        <div className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
          <Bot size={14} /> <span>Context Permissions</span>
        </div>
        {allFiles.length === 0 ? <div className="text-xs text-gray-400 italic">No files open.</div> : (
          <div className="flex flex-wrap gap-2">
            {allFiles.map(file => {
              const status = permissions[file.id] || 'read';
              return (
                <div key={file.id} className={`flex items-center gap-2 bg-white border border-gray-200 rounded-md pl-2 pr-1 py-1 text-xs shadow-sm transition-all ${status === 'none' ? 'opacity-50' : 'opacity-100'}`}>
                  {renderIcon(file.type)}
                  <span className="max-w-[80px] truncate font-medium text-gray-700">{file.name}</span>
                  <div className="h-4 w-px bg-gray-200 mx-1"></div>
                  <PermissionToggle status={status} onClick={() => onTogglePermission(file.id)} />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
          <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 flex-shrink-0"><Bot size={18} /></div>
              <div className="bg-white p-3 rounded-lg rounded-tl-none border border-gray-200 shadow-sm text-sm text-gray-700 max-w-[85%]">
                  Permissions updated. I can read/write files based on your selection above.
              </div>
          </div>
      </div>
      <div className="p-4 border-t border-gray-200 bg-white">
          <div className="relative">
              <input type="text" placeholder="Type a message..." className="w-full pl-4 pr-10 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-200 text-sm" />
              <button className="absolute right-2 top-2 p-1 text-purple-600 hover:bg-purple-50 rounded"><Send size={16} /></button>
          </div>
      </div>
    </div>
  );

  const PaneRenderer = ({ pane }) => {
    const activeTab = pane.tabs.find(t => t.id === pane.activeTabId);
    const [isDragOver, setIsDragOver] = useState(false);
    const mdContent = activeTab ? (fileContents[activeTab.id] || '') : '';
    const sessionPerms = activeTab?.type === 'session' ? (sessionPermissions[activeTab.id] || {}) : {};

    return (
      <div 
        className={`flex-1 min-w-[320px] max-w-full flex flex-col border-r border-gray-200 bg-white transition-all relative
          ${activePaneId === pane.id ? 'ring-1 ring-inset ring-blue-400 z-10' : 'opacity-95'}
        `}
        onClick={() => setActivePaneId(pane.id)}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => { setIsDragOver(false); handleDrop(e, pane.id); }}
      >
        {isDragOver && (
            <div className="absolute inset-0 bg-blue-50/50 border-2 border-blue-400 border-dashed z-50 flex items-center justify-center pointer-events-none backdrop-blur-[1px]">
                <div className="bg-blue-500 text-white px-4 py-2 rounded-lg shadow-lg font-medium flex items-center gap-2"><Download size={18} /> Drop to Open</div>
            </div>
        )}
        <div className="flex items-center h-9 bg-gray-100 border-b border-gray-200 overflow-hidden select-none">
            <div className="flex-1 flex overflow-x-auto no-scrollbar">
                {pane.tabs.map(tab => (
                    <div 
                        key={tab.id}
                        onClick={(e) => { e.stopPropagation(); openFileInPane(pane.id, tab, tab.mode); }}
                        className={`group flex items-center gap-2 px-3 min-w-[100px] max-w-[160px] text-xs cursor-pointer border-r border-gray-200 h-full ${pane.activeTabId === tab.id ? 'bg-white text-blue-600 border-t-2 border-t-blue-500 font-medium' : 'bg-gray-50 text-gray-500 hover:bg-gray-200'}`}
                    >
                        {renderIcon(tab.type)}
                        <span className="truncate flex-1">{tab.name}</span>
                        <button onClick={(e) => closeTab(e, pane.id, tab.id)} className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-gray-300 rounded-full"><X size={10} /></button>
                    </div>
                ))}
            </div>
            <button onClick={(e) => closePane(e, pane.id)} className="w-8 flex items-center justify-center hover:bg-red-50 hover:text-red-600 text-gray-400 h-full border-l border-gray-200"><X size={14} /></button>
        </div>
        <div className="flex-1 overflow-hidden relative bg-white">
            {!activeTab ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 pointer-events-none select-none">
                    <div className="bg-gray-50 p-4 rounded-full mb-3"><Split size={24} className="text-gray-300"/></div>
                    <p className="text-sm font-medium">Empty Pane</p>
                </div>
            ) : activeTab.type === 'session' ? (
                <SessionView allFiles={allOpenFiles} permissions={sessionPerms} onTogglePermission={(fileId) => togglePermission(activeTab.id, fileId)} />
            ) : activeTab.mode === 'diff' ? (
                 // --- RENDERED DIFF VIEW ---
                 <div className="flex flex-col h-full bg-white">
                    <div className="bg-blue-50 px-3 py-2 border-b border-blue-100 text-blue-800 flex justify-between items-center text-xs">
                       <span className="flex items-center gap-2"><GitCommit size={14}/> <strong>v3</strong> vs <strong>v2</strong></span>
                       <button onClick={() => openFileInPane(pane.id, activeTab, 'editor')} className="text-xs bg-white border border-blue-200 px-2 py-0.5 rounded hover:bg-blue-100">Exit Diff</button>
                    </div>
                    <div className="flex-1 overflow-auto p-6 space-y-1">
                       {CODE_DIFF_DATA.map((row, i) => (
                           <div key={i} className={`flex items-start rounded px-2 py-0.5 ${row.type === 'add' ? 'bg-green-50' : row.type === 'remove' ? 'bg-red-50 opacity-60' : ''}`}>
                               <span className="w-6 text-gray-400 text-right pr-3 select-none text-xs font-mono mt-1">{row.line}</span>
                               <div className={`flex-1 ${row.type === 'add' ? 'text-green-900' : row.type === 'remove' ? 'text-red-900' : 'text-gray-800'}`}>
                                    <RenderLine content={row.content} />
                               </div>
                           </div>
                       ))}
                    </div>
                 </div>
            ) : activeTab.type === 'md' ? (
                <TyporaBlockEditor content={mdContent} onChange={(val) => updateFileContent(activeTab.id, val)} />
            ) : (
                <div className="p-8"><h1 className="text-2xl font-bold mb-4">{activeTab.name}</h1><p className="text-gray-500">Generic Viewer</p></div>
            )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen w-full bg-white text-gray-800 font-sans overflow-hidden">
      <div className="h-12 bg-white border-b border-gray-200 flex items-center px-4 justify-between flex-shrink-0 z-20 shadow-sm">
        <div className="flex items-center gap-4">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1 hover:bg-gray-100 rounded text-gray-600"><Menu size={20} /></button>
          <button onClick={createNewPane} className="p-1.5 rounded hover:bg-gray-100 text-gray-600" title="Split Pane"><Split size={18} /></button>
        </div>
        <div className="text-sm font-medium text-gray-400 select-none">AI IDE Prototype</div>
      </div>
      <div className="flex-1 flex overflow-hidden relative">
        <div className={`${sidebarOpen ? 'w-64 opacity-100' : 'w-0 opacity-0'} flex-shrink-0 bg-gray-50 border-r border-gray-200 transition-all duration-300 flex flex-col overflow-hidden`}>
          <div className="flex-1 overflow-y-auto py-2">
             <div className="px-4 py-2 text-xs font-bold text-gray-400 uppercase">Explorer</div>
             {fileTree.map(item => <FileTreeItem key={item.id} item={item} />)}
          </div>
          <div className="border-t border-gray-200 bg-white flex flex-col" style={{ height: timelineExpanded ? '35%' : 'auto' }}>
            <div className="p-2 bg-gray-100 border-b border-gray-200 flex items-center justify-between cursor-pointer" onClick={() => setTimelineExpanded(!timelineExpanded)}>
                <div className="flex items-center gap-1 text-xs font-bold text-gray-600 uppercase">{timelineExpanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>} Timeline</div>
            </div>
            {timelineExpanded && (
                <div className="flex-1 overflow-y-auto p-4">
                    {!activeFileId ? <div className="text-xs text-gray-400 text-center mt-2">No file active</div> : 
                     activeTimeline.map(item => (
                        <div key={item.id} onClick={() => handleTimelineClick(activeFileId)} className="mb-4 relative pl-3 border-l border-gray-200 cursor-pointer group hover:bg-gray-50 rounded p-1 -ml-1">
                             <div className="absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full bg-blue-400 border-2 border-white group-hover:scale-110 transition-transform"></div>
                             <div className="text-xs font-medium text-gray-700 group-hover:text-blue-600">{item.message}</div>
                             <div className="text-[10px] text-gray-400 mt-0.5">{item.date} • {item.author}</div>
                        </div>
                    ))}
                </div>
            )}
          </div>
        </div>
        <div className="flex-1 flex bg-gray-100 relative overflow-x-auto scroll-smooth">
          {panes.length === 0 ? (
             <div className="w-full flex flex-col items-center justify-center text-gray-400">
                <button onClick={createNewPane} className="bg-white p-6 rounded-xl shadow-sm hover:shadow-md transition-all flex flex-col items-center"><Plus size={32} className="mb-2 text-blue-400" /><span className="text-sm font-medium">New Pane</span></button>
             </div>
          ) : panes.map(pane => <PaneRenderer key={pane.id} pane={pane} />)}
        </div>
      </div>
    </div>
  );
}