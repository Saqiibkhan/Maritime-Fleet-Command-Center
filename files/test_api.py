import os, tempfile
T = tempfile.mkdtemp()
os.environ.update(DATABASE_URL=f"sqlite:///{T}/t.db", STORAGE_DIR=T, MAX_UPLOAD_BYTES="2000", OPENROUTER_API_KEY="")
from fastapi.testclient import TestClient
from app.main import app
c = TestClient(app)
S = os.path.join(os.path.dirname(__file__), "..", "sample_data")


def up(name, user="demo", data=None):
    return c.post("/api/documents", files={"file": (name, data if data is not None else open(f"{S}/{name}", "rb").read())}, headers={"X-User": user})


def test_upload_persist_and_ready():
    r = up("kickoff_notes.md"); assert r.status_code == 201
    d = c.get(f"/api/documents/{r.json()['id']}").json()
    assert d["status"] == "ready" and d["doc_type"] == "meeting_notes"


def test_rejections():
    assert up("x.exe", data=b"MZ").status_code == 415
    assert up("big.txt", data=b"a" * 5000).status_code == 413
    assert up("fake.pdf", data=b"not a pdf").status_code == 415


def test_cited_answer_and_no_evidence():
    up("kickoff_notes.md")
    r = c.post("/api/ask", json={"question": "What is the project budget?"}).json()
    assert r["citations"] and r["review"] == "ok" and "50,000" in r["answer"]
    assert c.post("/api/ask", json={"question": "zebra migration patterns"}).json()["citations"] == []


def test_invoice_requires_approval_and_is_idempotent():
    up("invoice_acme.txt"); up("invoice_acme.txt")
    ap = [a for a in c.get("/api/approvals").json() if a["payload"]["fields"].get("vendor") == "Acme Cloud Services"]
    assert len(ap) == 1 and ap[0]["payload"]["fields"]["total"] == 1296.0 and not ap[0]["payload"]["issues"]
    assert c.get("/api/expenses/summary").json()["items"] == []  # nothing saved before approval
    assert c.post(f"/api/approvals/{ap[0]['id']}/decide", json={"decision": "approve"}).status_code == 200
    assert c.post(f"/api/approvals/{ap[0]['id']}/decide", json={"decision": "approve"}).status_code == 409
    assert c.get("/api/expenses/summary").json()["totals"][0]["total"] == 1296.0


def test_inconsistent_invoice_flagged():
    up("bad.txt", data=b"Invoice\nVendor: X\nInvoice No: A-1\nDate: 2026-01-01\nSubtotal: 100\nTax: 10\nTotal: 500")
    ap = [a for a in c.get("/api/approvals").json() if a["payload"]["fields"].get("vendor") == "X"][0]
    assert any("Inconsistent" in i for i in ap["payload"]["issues"])


def test_conflict_detection_in_synthesis():
    a, b = up("kickoff_notes.md").json()["id"], up("status_update.md").json()["id"]
    r = c.post("/api/synthesize", json={"document_ids": [a, b]}).json()
    assert {x["topic"] for x in r["conflicts"]} >= {"budget", "deadline"} and set(r["sources"]) == {a, b}


def test_authorization_isolation():
    did = up("kickoff_notes.md", user="alice").json()["id"]
    assert c.get(f"/api/documents/{did}", headers={"X-User": "bob"}).status_code == 404
    assert c.post("/api/ask", json={"question": "project budget"}, headers={"X-User": "bob"}).json()["citations"] == []
    assert c.post("/api/synthesize", json={"document_ids": [did]}, headers={"X-User": "bob"}).status_code == 400
