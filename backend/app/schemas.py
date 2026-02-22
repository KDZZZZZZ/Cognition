from datetime import datetime
from typing import Optional, Dict, Any, Literal
from pydantic import BaseModel, Field
from enum import Enum


class FileType(str, Enum):
    FOLDER = "folder"
    MD = "md"
    PDF = "pdf"
    CODE = "code"
    SESSION = "session"
    IMAGE = "image"
    DOCX = "docx"
    TXT = "txt"


class Permission(str, Enum):
    READ = "read"
    WRITE = "write"
    NONE = "none"


# Permission as a string literal for API responses
PermissionLiteral = str  # "read" | "write" | "none"


class Author(str, Enum):
    HUMAN = "human"
    AGENT = "agent"


class ChangeType(str, Enum):
    EDIT = "edit"
    REFACTOR = "refactor"
    DELETE = "delete"
    CREATE = "create"


class DiffEventStatus(str, Enum):
    PENDING = "pending"
    RESOLVED = "resolved"


class LineDecision(str, Enum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


# Request Models
class FileUploadRequest(BaseModel):
    filename: str
    file_type: FileType
    parent_id: Optional[str] = None  # Parent folder ID for hierarchy


class FolderCreateRequest(BaseModel):
    name: str
    parent_id: Optional[str] = None  # Parent folder ID, null for root


class ViewportUpdate(BaseModel):
    file_id: str
    page: int
    scroll_y: float
    visible_range: tuple[int, int]


class ViewportUpdateRequest(BaseModel):
    session_id: str
    file_id: str
    page: int = 1
    scroll_y: float = 0
    visible_range_start: int = 0
    visible_range_end: int = 0


class ChatMessage(BaseModel):
    role: str
    content: str
    timestamp: Optional[datetime] = None


class ChatRequest(BaseModel):
    session_id: str
    message: str
    context_files: list[str] = Field(default_factory=list)
    viewport_context: Optional[str] = None
    active_file_id: Optional[str] = None
    active_page: Optional[int] = None
    compact_mode: Optional[Literal["auto", "off", "force"]] = "auto"
    task_id: Optional[str] = None
    model: Optional[str] = None
    use_tools: bool = True
    permissions: Optional[dict[str, str]] = None  # Initial permissions for new sessions


class PermissionUpdate(BaseModel):
    session_id: str
    file_id: str
    permission: Permission


class BlockEditRequest(BaseModel):
    file_id: str
    block_id: str
    new_content: str
    operation: str = "update"  # update, insert, delete


class FileUpdate(BaseModel):
    content: str
    author: Author = Author.HUMAN
    change_type: ChangeType = ChangeType.EDIT
    summary: str = "Content updated"
    context_snapshot: Optional[str] = None  # Optional context about what triggered the change


class MoveFileRequest(BaseModel):
    new_parent_id: Optional[str] = None


class DiffEventCreateRequest(BaseModel):
    new_content: str
    summary: Optional[str] = "Agent proposed edit"
    author: Author = Author.AGENT


class DiffLineUpdateRequest(BaseModel):
    decision: LineDecision


class DiffEventFinalizeRequest(BaseModel):
    final_content: Optional[str] = None
    summary: Optional[str] = "Finalize diff event"
    author: Author = Author.HUMAN


# Response Models
class APIResponse(BaseModel):
    success: bool
    data: Optional[dict] = None
    error: Optional[str] = None


class FileMetadata(BaseModel):
    id: str
    name: str
    file_type: FileType
    size: int
    created_at: datetime
    updated_at: datetime
    page_count: Optional[int] = None
    url: Optional[str] = None
    parent_id: Optional[str] = None
    children: Optional[list] = None  # For nested tree structure


class ChunkMetadata(BaseModel):
    id: str
    file_id: str
    page: int
    bbox: tuple[float, float, float, float]  # x0, y0, x1, y1
    content: str
    embedding_id: Optional[str] = None


class VersionNode(BaseModel):
    id: str
    file_id: str
    timestamp: datetime
    author: Author
    change_type: ChangeType
    summary: str
    diff_patch: Optional[str] = None
    context_snapshot: Optional[str] = None


class ChatResponse(BaseModel):
    message_id: str
    role: str
    content: str
    timestamp: datetime
    tool_calls: Optional[list[dict]] = None
    citations: Optional[list[dict]] = None


class SessionInfo(BaseModel):
    id: str
    created_at: datetime
    permissions: Dict[str, str]  # {"file_id": "read"|"write"|"none"}
    name: Optional[str] = None
