from datetime import datetime
from typing import Optional, List
from sqlalchemy import String, DateTime, Integer, Text, JSON, ForeignKey, Enum as SQLEnum, Float, Boolean
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
import enum


class Base(DeclarativeBase):
    pass


class Author(str, enum.Enum):
    HUMAN = "human"
    AGENT = "agent"


class ChangeType(str, enum.Enum):
    EDIT = "edit"
    REFACTOR = "refactor"
    DELETE = "delete"
    CREATE = "create"


class DiffEventStatus(str, enum.Enum):
    PENDING = "pending"
    RESOLVED = "resolved"


class LineDecision(str, enum.Enum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class FileType(str, enum.Enum):
    FOLDER = "folder"
    MD = "md"
    PDF = "pdf"
    CODE = "code"
    SESSION = "session"
    IMAGE = "image"
    DOCX = "docx"
    TXT = "txt"


class File(Base):
    __tablename__ = "files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_type: Mapped[FileType] = mapped_column(SQLEnum(FileType), nullable=False)
    path: Mapped[str] = mapped_column(String(500), nullable=False)
    size: Mapped[int] = mapped_column(Integer, default=0)
    page_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)  # Renamed from 'metadata' to avoid SQLAlchemy conflict
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Hierarchy support: self-referential relationship for folder structure
    parent_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=True, index=True
    )
    children: Mapped[List["File"]] = relationship(
        "File", back_populates="parent", cascade="all, delete-orphan"
    )
    parent: Mapped[Optional["File"]] = relationship("File", back_populates="children", remote_side=[id])

    # Relationship to versions
    versions: Mapped[List["Version"]] = relationship(
        "Version", back_populates="file", cascade="all, delete-orphan", lazy="dynamic"
    )
    diff_events: Mapped[List["DiffEvent"]] = relationship(
        "DiffEvent", back_populates="file", cascade="all, delete-orphan"
    )


class DocumentChunk(Base):
    __tablename__ = "document_chunks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    file_id: Mapped[str] = mapped_column(String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True)
    page: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    bbox: Mapped[Optional[tuple]] = mapped_column(JSON, nullable=True)  # x0, y0, x1, y1
    embedding_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Version(Base):
    __tablename__ = "versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    file_id: Mapped[str] = mapped_column(String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True)
    author: Mapped[Author] = mapped_column(SQLEnum(Author), nullable=False)
    change_type: Mapped[ChangeType] = mapped_column(SQLEnum(ChangeType), nullable=False)
    summary: Mapped[str] = mapped_column(String(500), nullable=False)
    diff_patch: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    context_snapshot: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    # Relationship back to file
    file: Mapped["File"] = relationship("File", back_populates="versions")


class DiffEvent(Base):
    __tablename__ = "diff_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    author: Mapped[Author] = mapped_column(SQLEnum(Author), nullable=False, default=Author.AGENT)
    old_content: Mapped[str] = mapped_column(Text, nullable=False)
    new_content: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    status: Mapped[DiffEventStatus] = mapped_column(
        SQLEnum(DiffEventStatus), nullable=False, default=DiffEventStatus.PENDING, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    file: Mapped["File"] = relationship("File", back_populates="diff_events")
    lines: Mapped[List["DiffLineSnapshot"]] = relationship(
        "DiffLineSnapshot", back_populates="event", cascade="all, delete-orphan"
    )


class DiffLineSnapshot(Base):
    __tablename__ = "diff_line_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    event_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("diff_events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    line_no: Mapped[int] = mapped_column(Integer, nullable=False)
    old_line: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    new_line: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    decision: Mapped[LineDecision] = mapped_column(
        SQLEnum(LineDecision), nullable=False, default=LineDecision.PENDING, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    event: Mapped["DiffEvent"] = relationship("DiffEvent", back_populates="lines")


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    permissions: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(36), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(50), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    tool_calls: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    tool_results: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # Store tool execution results
    citations: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class ConversationCompaction(Base):
    __tablename__ = "conversation_compactions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    trigger_reason: Mapped[str] = mapped_column(String(120), nullable=False)
    before_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    after_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    summary_text: Mapped[str] = mapped_column(Text, nullable=False)
    key_facts_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    open_loops_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    source_from_ts: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    source_to_ts: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class SessionTaskState(Base):
    __tablename__ = "session_task_states"

    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True
    )
    task_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    state: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    goal: Mapped[str] = mapped_column(Text, nullable=False)
    plan_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    current_step: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_steps: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    artifacts_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    blocked_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    last_message_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)
