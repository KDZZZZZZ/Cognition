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
    WEB = "web"
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


class DocumentPageAsset(Base):
    __tablename__ = "document_page_assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    page: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    image_path: Mapped[Optional[str]] = mapped_column(String(600), nullable=True)
    image_url: Mapped[Optional[str]] = mapped_column(String(600), nullable=True)
    text_anchor: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class DocumentSegment(Base):
    __tablename__ = "document_segments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_type: Mapped[str] = mapped_column(String(16), nullable=False, index=True)  # md/pdf/web/...
    page: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    section: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    bbox: Mapped[Optional[tuple]] = mapped_column(JSON, nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    segment_type: Mapped[str] = mapped_column(String(32), nullable=False, default="paragraph")
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="local")
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class DocumentAsset(Base):
    __tablename__ = "document_assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    page_or_section: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    asset_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)  # image/screenshot/...
    path: Mapped[Optional[str]] = mapped_column(String(600), nullable=True)
    url: Mapped[Optional[str]] = mapped_column(String(600), nullable=True)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class SegmentEmbedding(Base):
    __tablename__ = "segment_embeddings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    segment_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("document_segments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    modality: Mapped[str] = mapped_column(String(16), nullable=False, index=True)  # text/image/fused
    dim: Mapped[int] = mapped_column(Integer, nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False, default="qwen3-vl-embedding")
    vector_ref: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class FileIndexStatus(Base):
    __tablename__ = "file_index_status"

    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("files.id", ondelete="CASCADE"), primary_key=True
    )
    parse_status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    embedding_status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


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


class SessionViewport(Base):
    __tablename__ = "session_viewports"

    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True
    )
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("files.id", ondelete="CASCADE"), primary_key=True
    )
    file_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    file_type: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    page: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    visible_unit: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    visible_start: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    visible_end: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    anchor_block_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    pending_diff_event_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    scroll_y: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


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


class SessionTaskRegistry(Base):
    __tablename__ = "session_task_registries"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_message_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="running", index=True)
    active_task_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    goal_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    catalog_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class SessionTask(Base):
    __tablename__ = "session_tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    registry_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("session_task_registries.id", ondelete="CASCADE"), nullable=False, index=True
    )
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    task_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    goal: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending", index=True)
    current_step_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_steps: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    blocked_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    missing_inputs_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    artifacts_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    last_message_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class SessionTaskStep(Base):
    __tablename__ = "session_task_steps"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    task_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("session_tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    step_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending", index=True)
    required_inputs_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    resolved_inputs_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    missing_inputs_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    output_markdown: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    output_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    citations_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    compact_anchor_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)
