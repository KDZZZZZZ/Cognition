import { FileTree } from '../filetree/FileTree';
import { Timeline } from '../timeline/Timeline';

export function Sidebar() {
  return (
    <div className="w-64 flex-shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col overflow-hidden">
      <FileTree />
      <Timeline />
    </div>
  );
}
