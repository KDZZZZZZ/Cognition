import { FileTree } from '../filetree/FileTree';
import { Timeline } from '../timeline/Timeline';

export function Sidebar() {
  return (
    <div className="w-64 flex-shrink-0 bg-theme-bg/30 border-r border-theme-border/20 flex flex-col overflow-hidden transition-colors duration-300">
      <FileTree />
      <Timeline />
    </div>
  );
}
