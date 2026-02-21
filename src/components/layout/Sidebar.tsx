import { FileTree } from '../filetree/FileTree';
import { Timeline } from '../timeline/Timeline';

export function Sidebar() {
  return (
    <div
      className="w-64 flex-shrink-0 border-r border-theme-border/30 paper-divider-dashed flex flex-col overflow-hidden transition-colors duration-300"
      style={{ backgroundColor: 'var(--theme-surface)' }}
    >
      <FileTree />
      <Timeline />
    </div>
  );
}
