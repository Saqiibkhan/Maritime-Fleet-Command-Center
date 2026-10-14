import hashlib, os, re, uuid
from fastapi import BackgroundTasks, Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import func
from . import logic
from .core import *

Base.metadata.create_all(engine)
app = FastAPI(title="Agentic Drive")
ALLOWED = {".pdf", ".docx", ".txt", ".md", ".csv", ".xlsx"}
MAGIC = {".pdf": b"%PDF", ".docx": b"PK", ".xlsx": b"PK"}


def db_dep():
    with SessionLocal() as db:
        yield db


def user(x_user: str = Header("demo")):
    return re.sub(r"[^\w.-]", "", x_user)[:40] or "demo"


def own(db, model, id, u):
    row = db.get(model, id)
    if not row or row.owner != u: raise HTTPException(404, f"{model.__name__} not found")
    return row


def row(r): return {c.name: getattr(r, c.name) for c in r.__table__.columns if c.name not in ("path", "vec")}


@app.exception_handler(Exception)
async def err(_, e):
    return JSONResponse({"error": "internal_error", "message": "Something went wrong."}, 500)


@app.get("/api/health")
def health(): return {"status": "ok", "llm": bool(os.getenv("OPENROUTER_API_KEY"))}


@app.post("/api/documents", status_code=201)
async def upload(bg: BackgroundTasks, file: UploadFile = File(...), folder: str = "/", u=Depends(user), db=Depends(db_dep)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED: raise HTTPException(415, f"Unsupported type '{ext}'. Allowed: {', '.join(sorted(ALLOWED))}")
    data = await file.read()
    if len(data) > int(os.getenv("MAX_UPLOAD_BYTES", 10 * 1024 * 1024)): raise HTTPException(413, "File too large.")
    if ext in MAGIC and not data.startswith(MAGIC[ext]): raise HTTPException(415, "File content does not match its extension.")
    name = re.sub(r"[^\w. -]", "_", os.path.basename(file.filename))
    path = os.path.join(STORAGE, uuid.uuid4().hex + ext)  # never use the client's name on disk
    open(path, "wb").write(data)
    d = Document(owner=u, name=name, sha=hashlib.sha256(data).hexdigest(), path=path, size=len(data), folder=folder)
    db.add(d); log(db, u, "document.uploaded", name=name); db.commit()
    bg.add_task(logic.ingest, d.id)
    return row(d)


@app.get("/api/documents")
def list_docs(q: str = "", trashed: bool = False, page: int = 1, size: int = 50, u=Depends(user), db=Depends(db_dep)):
    qs = db.query(Document).filter_by(owner=u, trashed=trashed)
    if q: qs = qs.filter(Document.name.ilike(f"%{q}%"))
    return {"total": qs.count(), "items": [row(d) for d in qs.order_by(Document.created.desc()).offset((page - 1) * size).limit(size)]}


@app.get("/api/documents/{id}")
def get_doc(id: int, u=Depends(user), db=Depends(db_dep)): return row(own(db, Document, id, u))


@app.get("/api/documents/{id}/file")
def download(id: int, u=Depends(user), db=Depends(db_dep)):
    d = own(db, Document, id, u); return FileResponse(d.path, filename=d.name)


class Patch(BaseModel):
    name: str | None = None
    folder: str | None = None
    tags: list[str] | None = None
    trashed: bool | None = None


@app.patch("/api/documents/{id}")
def patch(id: int, p: Patch, u=Depends(user), db=Depends(db_dep)):
    d = own(db, Document, id, u)
    for k, v in p.model_dump(exclude_none=True).items(): setattr(d, k, v)
    log(db, u, "document.updated", doc=id, **p.model_dump(exclude_none=True)); db.commit(); return row(d)


@app.post("/api/documents/{id}/reprocess")
def reprocess(id: int, bg: BackgroundTasks, u=Depends(user), db=Depends(db_dep)):
    own(db, Document, id, u); bg.add_task(logic.ingest, id); return {"queued": True}


@app.get("/api/chunks/{id}")
def chunk(id: int, u=Depends(user), db=Depends(db_dep)):
    c = own(db, Chunk, id, u); return {"id": c.id, "doc_id": c.doc_id, "page": c.page, "text": c.text}


class Ask(BaseModel):
    question: str


@app.post("/api/ask")
def ask(a: Ask, u=Depends(user), db=Depends(db_dep)):
    r = logic.answer(db, u, a.question); db.commit(); return r


class Synth(BaseModel):
    document_ids: list[int]
    title: str = "Cross-document summary"


@app.post("/api/synthesize", status_code=201)
def synth(s: Synth, u=Depends(user), db=Depends(db_dep)):
    try: return row(logic.synthesize(db, u, s.document_ids, s.title))
    except ValueError as e: raise HTTPException(400, str(e))


@app.get("/api/approvals")
def approvals(status: str = "pending", u=Depends(user), db=Depends(db_dep)):
    return [row(a) for a in db.query(Approval).filter_by(owner=u, status=status).order_by(Approval.id.desc())]


class Decision(BaseModel):
    decision: str  # approve|reject
    edits: dict | None = None


@app.post("/api/approvals/{id}/decide")
def decide(id: int, d: Decision, u=Depends(user), db=Depends(db_dep)):
    if d.decision not in ("approve", "reject"): raise HTTPException(422, "decision must be approve or reject")
    try: logic.decide(db, own(db, Approval, id, u), d.decision, d.edits)
    except ValueError as e: raise HTTPException(409, str(e))
    db.commit(); return {"ok": True}


@app.get("/api/expenses/summary")
def expenses(u=Depends(user), db=Depends(db_dep)):
    rows = db.query(Expense.currency, func.sum(Expense.total), func.count()).filter_by(owner=u).group_by(Expense.currency).all()
    return {"totals": [{"currency": c, "total": t, "count": n} for c, t, n in rows],
            "items": [row(e) for e in db.query(Expense).filter_by(owner=u)]}


@app.get("/api/activity")
def activity(u=Depends(user), db=Depends(db_dep)):
    return [{"event": a.event, "detail": a.detail, "ts": a.ts.isoformat()} for a in db.query(Activity).filter_by(owner=u).order_by(Activity.id.desc()).limit(100)]


app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "..", "static"), html=True))
