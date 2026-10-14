import os
from datetime import datetime
from sqlalchemy import create_engine, JSON, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

DB_URL = os.getenv("DATABASE_URL", "sqlite:///./data/agentic.db")
STORAGE = os.getenv("STORAGE_DIR", "./data/files")
os.makedirs("data", exist_ok=True)
os.makedirs(STORAGE, exist_ok=True)
engine = create_engine(DB_URL, connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(engine, expire_on_commit=False)
now = datetime.utcnow


class Base(DeclarativeBase):
    pass


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(index=True)
    name: Mapped[str]
    sha: Mapped[str] = mapped_column(index=True)
    path: Mapped[str]
    size: Mapped[int]
    status: Mapped[str] = mapped_column(default="queued")  # queued|processing|ready|failed
    error: Mapped[str | None] = mapped_column(default=None)
    trashed: Mapped[bool] = mapped_column(default=False)
    doc_type: Mapped[str | None] = mapped_column(default=None)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    folder: Mapped[str] = mapped_column(default="/")
    suggested_folder: Mapped[str | None] = mapped_column(default=None)
    duplicate_of: Mapped[int | None] = mapped_column(default=None)
    created: Mapped[datetime] = mapped_column(default=now)


class Chunk(Base):
    __tablename__ = "chunks"
    id: Mapped[int] = mapped_column(primary_key=True)
    doc_id: Mapped[int] = mapped_column(index=True)
    owner: Mapped[str] = mapped_column(index=True)
    idx: Mapped[int]
    page: Mapped[int]
    text: Mapped[str]
    vec: Mapped[list] = mapped_column(JSON)


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = (UniqueConstraint("key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(index=True)
    kind: Mapped[str]
    key: Mapped[str]  # idempotency key
    doc_id: Mapped[int]
    status: Mapped[str] = mapped_column(default="pending")  # pending|approved|rejected
    payload: Mapped[dict] = mapped_column(JSON)
    created: Mapped[datetime] = mapped_column(default=now)


class Expense(Base):
    __tablename__ = "expenses"
    __table_args__ = (UniqueConstraint("doc_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(index=True)
    doc_id: Mapped[int]
    vendor: Mapped[str | None]
    number: Mapped[str | None]
    date: Mapped[str | None]
    currency: Mapped[str | None]
    total: Mapped[float]


class Activity(Base):
    __tablename__ = "activity"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(index=True)
    event: Mapped[str]
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    ts: Mapped[datetime] = mapped_column(default=now)


class Artifact(Base):
    __tablename__ = "artifacts"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(index=True)
    title: Mapped[str]
    content: Mapped[str]
    sources: Mapped[list] = mapped_column(JSON)
    conflicts: Mapped[list] = mapped_column(JSON, default=list)
    created: Mapped[datetime] = mapped_column(default=now)


def log(db, owner, event, **detail):
    db.add(Activity(owner=owner, event=event, detail=detail))
