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
    meta: Mapped[dict] = mapped_column(JSON, default={})  # Renamed from 'metadata' to avoid SQLAlchemy conflict
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


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    permissions: Mapped[dict] = mapped_column(JSON, default={})
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
