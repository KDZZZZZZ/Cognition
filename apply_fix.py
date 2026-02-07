import os

file_path = 'backend/app/api/chat.py'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Imports
content = content.replace('from app.models import Session, ChatMessage', 'from app.models import Session, ChatMessage, File as FileModel')

# 2. Context
old_ctx = '    # Create tool context with permissions\n    context = await permission_middleware.create_context(\n        session_id=request.session_id,\n        db=db\n    )'
new_ctx = '    # Fetch file info for system prompt\n    files_info = {}\n    if session.permissions:\n        file_ids = list(session.permissions.keys())\n        if file_ids:\n            result = await db.execute(select(FileModel).where(FileModel.id.in_(file_ids)))\n            files = result.scalars().all()\n            files_info = {f.id: f.name for f in files}\n\n    # Create tool context with permissions\n    context = await permission_middleware.create_context(\n        session_id=request.session_id,\n        db=db\n    )'
content = content.replace(old_ctx, new_ctx)

# 3. Prompt Call
content = content.replace('{\"role\": \"system\", \"content\": _build_system_prompt(session.permissions)}', '{\"role\": \"system\", \"content\": _build_system_prompt(session.permissions, files_info)}')

# 4. Prompt Function
old_header = 'def _build_system_prompt(permissions: dict) -> str:'
new_header = 'def _build_system_prompt(permissions: dict, files_info: dict = None) -> str:'
content = content.replace(old_header, new_header)

old_body_end = '        if files_with_read:\n            base_prompt += f"\\n\\nYou have read access to {len(files_with_read)} file(s)."\n        if files_with_write:\n            base_prompt += f"\\n\\nYou can modify {len(files_with_write)} markdown file(s)."'
new_body_end = '        if files_with_read:\n            base_prompt += f"\\n\\nYou have read access to {len(files_with_read)} file(s):"\n            for fid in files_with_read:\n                name = files_info.get(fid, fid) if files_info else fid\n                base_prompt += f"\\n- {name} ({fid})"\n        \n        if files_with_write:\n            base_prompt += f"\\n\\nYou can modify {len(files_with_write)} markdown file(s):"\n            for fid in files_with_write:\n                name = files_info.get(fid, fid) if files_info else fid\n                base_prompt += f"\\n- {name} ({fid})"'

content = content.replace(old_body_end, new_body_end)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')
