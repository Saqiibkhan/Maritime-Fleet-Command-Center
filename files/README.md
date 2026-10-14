# Agentic Drive

AI knowledge workspace: upload files → extract & index → cited Q&A → cross-document synthesis with conflict detection → invoice-to-expense workflow with human approval.

## Run
```
pip install -r requirements.txt
cp .env.example .env   # optional; set OPENROUTER_API_KEY for LLM answers
uvicorn app.main:app --reload   # open http://localhost:8000
pytest -q
```
## 3-minute demo (sample_data/)
1. Upload all three sample files. Invoice → pending expense with page evidence.
2. Ask: "What is the project budget?" → cited answer. Ask "zebra migration" → "no evidence".
3. Select kickoff_notes + status_update → Synthesize → budget and deadline conflicts shown with sources.
4. Approvals → approve the invoice → expense summary updates. Activity shows the audit trail.

## What is real vs. simplified (honest status)
Real: persistent storage + DB, ingestion with page/row locations, BM25+vector hybrid search, per-user authorization (X-User header), deterministic invoice parsing/validation, idempotent workflows, approval gate, audit log, 7 passing tests.
Simplified: SQLite default (SQLAlchemy URL is swappable; pgvector not yet used — embeddings are hashed bag-of-words, stored as JSON); no real login (header-based identity); answers are extractive unless an OpenRouter key is set; vanilla-JS UI served by FastAPI instead of Next.js; no LangGraph, OCR, knowledge graph, or Alembic yet.
