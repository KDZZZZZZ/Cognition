import { parseBold } from '../../utils/cn';

interface RenderLineProps {
  content: string;
}

export function RenderLine({ content }: RenderLineProps) {
  if (!content) return <div className="h-6" />;

  // Headers
  if (content.startsWith('# ')) {
    return (
      <h1 className="text-3xl font-bold text-gray-900 mt-2 mb-2">
        {content.replace('# ', '')}
      </h1>
    );
  }
  if (content.startsWith('## ')) {
    return (
      <h2 className="text-2xl font-semibold text-gray-800 mt-2 mb-2 pb-1 border-b border-gray-200">
        {content.replace('## ', '')}
      </h2>
    );
  }

  // Blockquotes
  if (content.startsWith('> ')) {
    return (
      <blockquote className="border-l-4 border-blue-400 pl-4 py-1 my-1 bg-blue-50 italic text-gray-600">
        {content.replace('> ', '')}
      </blockquote>
    );
  }

  // Code Blocks (Simplified for single line view)
  if (content.trim().startsWith('```')) {
    return <div className="font-mono text-gray-400 text-xs">{content}</div>;
  }

  // Lists
  if (content.trim().startsWith('- [ ]')) {
    return (
      <div className="flex items-center gap-2 my-1">
        <input type="checkbox" readOnly className="rounded" />
        <span>{parseBold(content.replace('- [ ]', ''))}</span>
      </div>
    );
  }
  if (content.trim().startsWith('- [x]')) {
    return (
      <div className="flex items-center gap-2 my-1">
        <input type="checkbox" checked readOnly className="rounded" />
        <span className="line-through text-gray-400">
          {parseBold(content.replace('- [x]', ''))}
        </span>
      </div>
    );
  }
  if (content.trim().startsWith('- ')) {
    return (
      <li className="ml-4 list-disc">{parseBold(content.replace('- ', ''))}</li>
    );
  }

  // Regular Paragraph with Bold Parsing
  return (
    <p className="leading-relaxed min-h-[1.5em]">{parseBold(content)}</p>
  );
}
