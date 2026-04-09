"""
# ═══════════════════════════════════════════════════════════════
#  NIFTY50 Signal Bot — FastAPI Backend
# ═══════════════════════════════════════════════════════════════
#
#  INSTALL & RUN
#  ─────────────
#  1.  cd backend
#  2.  pip install -r requirements.txt
#  3.  uvicorn main:app --reload --port 8000
#
#  The SQLite database (signal_bot.db) is created automatically
#  in the same directory on first run.
#
#  API BASE URL (default): http://localhost:8000
#
#  ENDPOINTS
#  ─────────
#  GET    /configs              – list all saved configs
#  POST   /configs              – save a named config
#  DELETE /configs/{id}         – delete a config
#  GET    /backtests            – list all backtest summaries
#  POST   /backtests            – save a backtest result
#  GET    /backtests/{id}       – get full backtest detail + trades
#  DELETE /backtests/{id}       – delete a backtest
# ═══════════════════════════════════════════════════════════════
"""

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── DB setup ────────────────────────────────────────────────────

DB_PATH = Path(__file__).parent / "signal_bot.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


@contextmanager
def db():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS configs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                params     TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS backtests (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                config_id  INTEGER,
                metrics    TEXT NOT NULL,
                trades     TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
        """)


# ── App ─────────────────────────────────────────────────────────

app = FastAPI(title="NIFTY50 Signal Bot API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    init_db()


# ── Pydantic models ─────────────────────────────────────────────

class ConfigIn(BaseModel):
    name: str
    params: dict[str, Any]


class BacktestIn(BaseModel):
    name: str
    config_id: int | None = None
    metrics: dict[str, Any]
    trades: list[dict[str, Any]]


# ── Helpers ─────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)


# ── Config endpoints ─────────────────────────────────────────────

@app.get("/configs")
def list_configs():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name, params, created_at FROM configs ORDER BY created_at DESC"
        ).fetchall()
    result = []
    for r in rows:
        d = row_to_dict(r)
        d["params"] = json.loads(d["params"])
        result.append(d)
    return result


@app.post("/configs", status_code=201)
def save_config(body: ConfigIn):
    now = now_iso()
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO configs (name, params, created_at) VALUES (?, ?, ?)",
            (body.name, json.dumps(body.params), now),
        )
        new_id = cur.lastrowid
    return {"id": new_id, "name": body.name, "params": body.params, "created_at": now}


@app.delete("/configs/{config_id}", status_code=200)
def delete_config(config_id: int):
    with db() as conn:
        affected = conn.execute(
            "DELETE FROM configs WHERE id = ?", (config_id,)
        ).rowcount
    if not affected:
        raise HTTPException(status_code=404, detail="Config not found")
    return {"deleted": config_id}


# ── Backtest endpoints ───────────────────────────────────────────

@app.get("/backtests")
def list_backtests():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name, config_id, metrics, created_at FROM backtests ORDER BY created_at DESC"
        ).fetchall()
    result = []
    for r in rows:
        d = row_to_dict(r)
        d["metrics"] = json.loads(d["metrics"])
        result.append(d)
    return result


@app.post("/backtests", status_code=201)
def save_backtest(body: BacktestIn):
    now = now_iso()
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO backtests (name, config_id, metrics, trades, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                body.name,
                body.config_id,
                json.dumps(body.metrics),
                json.dumps(body.trades),
                now,
            ),
        )
        new_id = cur.lastrowid
    return {
        "id": new_id,
        "name": body.name,
        "config_id": body.config_id,
        "metrics": body.metrics,
        "created_at": now,
    }


@app.get("/backtests/{backtest_id}")
def get_backtest(backtest_id: int):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM backtests WHERE id = ?", (backtest_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Backtest not found")
    d = row_to_dict(row)
    d["metrics"] = json.loads(d["metrics"])
    d["trades"] = json.loads(d["trades"])
    return d


@app.delete("/backtests/{backtest_id}", status_code=200)
def delete_backtest(backtest_id: int):
    with db() as conn:
        affected = conn.execute(
            "DELETE FROM backtests WHERE id = ?", (backtest_id,)
        ).rowcount
    if not affected:
        raise HTTPException(status_code=404, detail="Backtest not found")
    return {"deleted": backtest_id}
