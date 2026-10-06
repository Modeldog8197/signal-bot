"""Optional, same-origin SQLite persistence for local research. No trade execution."""

import json
import os
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator, model_validator

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SIGNAL_BOT_DB", ROOT / "signal_bot.db"))


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
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
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                params TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS backtests (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                config_id INTEGER, metrics TEXT NOT NULL, trades TEXT NOT NULL,
                created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS experiments (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                report TEXT NOT NULL, created_at TEXT NOT NULL);
        """)


@asynccontextmanager
async def lifespan(app):
    init_db()
    yield


app = FastAPI(title="Signal Bot Research API", version="2.0.0", lifespan=lifespan)


class NamedInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Name must contain text.")
        return value

    @model_validator(mode="after")
    def finite_and_bounded(self):
        try:
            payload = json.dumps(self.model_dump(), allow_nan=False)
        except (ValueError, TypeError) as exc:
            raise ValueError("Payload must contain finite JSON values.") from exc
        if len(payload.encode()) > 4_000_000:
            raise ValueError("Payload exceeds the 4 MB research report limit.")
        return self


class ConfigIn(NamedInput):
    params: dict[str, Any]


class BacktestIn(NamedInput):
    config_id: int | None = Field(default=None, gt=0)
    metrics: dict[str, Any]
    trades: list[dict[str, Any]] = Field(max_length=10000)


class ExperimentIn(NamedInput):
    report: dict[str, Any]

    @field_validator("report")
    @classmethod
    def check_report(cls, value):
        if value.get("version") != "2.0.0" or not all(
            isinstance(value.get(k), dict)
            for k in ("dataset", "selectedConfig", "split", "result", "benchmark")
        ):
            raise ValueError("Use an exported v2 experiment report.")
        for key in ("result", "benchmark"):
            if not isinstance(value[key].get("metrics"), dict):
                raise ValueError("Both portfolios need metrics.")
        return value


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def unpack(row, fields):
    result = dict(row)
    for key in fields:
        if key in result:
            result[key] = json.loads(result[key])
    return result


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": "2.0.0",
        "purpose": "Local experiment persistence; client-computed reports, no order routing",
    }


@app.get("/configs")
def list_configs(limit: int = Query(50, ge=1, le=100)):
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM configs ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [unpack(r, ["params"]) for r in rows]


@app.post("/configs", status_code=201)
def save_config(body: ConfigIn):
    created = now_iso()
    with db() as conn:
        cursor = conn.execute(
            "INSERT INTO configs (name,params,created_at) VALUES (?,?,?)",
            (body.name, json.dumps(body.params, allow_nan=False), created),
        )
    return {"id": cursor.lastrowid, **body.model_dump(), "created_at": created}


@app.delete("/configs/{config_id}")
def delete_config(config_id: int):
    with db() as conn:
        affected = conn.execute("DELETE FROM configs WHERE id=?", (config_id,)).rowcount
        if not affected:
            raise HTTPException(404, "Config not found")
        conn.execute(
            "UPDATE backtests SET config_id=NULL WHERE config_id=?", (config_id,)
        )
    return {"deleted": config_id}


@app.get("/backtests")
def list_backtests(limit: int = Query(50, ge=1, le=100)):
    with db() as conn:
        rows = conn.execute(
            "SELECT id,name,config_id,metrics,created_at FROM backtests ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [unpack(r, ["metrics"]) for r in rows]


@app.post("/backtests", status_code=201)
def save_backtest(body: BacktestIn):
    created = now_iso()
    with db() as conn:
        if (
            body.config_id is not None
            and not conn.execute(
                "SELECT id FROM configs WHERE id=?", (body.config_id,)
            ).fetchone()
        ):
            raise HTTPException(404, "Config not found")
        cursor = conn.execute(
            "INSERT INTO backtests (name,config_id,metrics,trades,created_at) VALUES (?,?,?,?,?)",
            (
                body.name,
                body.config_id,
                json.dumps(body.metrics, allow_nan=False),
                json.dumps(body.trades, allow_nan=False),
                created,
            ),
        )
    result = body.model_dump()
    result.pop("trades")
    return {"id": cursor.lastrowid, **result, "created_at": created}


@app.get("/backtests/{backtest_id}")
def get_backtest(backtest_id: int):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM backtests WHERE id=?", (backtest_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "Backtest not found")
    return unpack(row, ["metrics", "trades"])


@app.delete("/backtests/{backtest_id}")
def delete_backtest(backtest_id: int):
    with db() as conn:
        if not conn.execute(
            "DELETE FROM backtests WHERE id=?", (backtest_id,)
        ).rowcount:
            raise HTTPException(404, "Backtest not found")
    return {"deleted": backtest_id}


@app.post("/experiments", status_code=201)
def save_experiment(body: ExperimentIn):
    created = now_iso()
    with db() as conn:
        cursor = conn.execute(
            "INSERT INTO experiments (name,report,created_at) VALUES (?,?,?)",
            (body.name, json.dumps(body.report, allow_nan=False), created),
        )
    return {
        "id": cursor.lastrowid,
        "name": body.name,
        "created_at": created,
        "verification": "Client-computed report; the API stores rather than independently recomputes results",
    }


@app.get("/experiments")
def list_experiments(limit: int = Query(50, ge=1, le=100)):
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM experiments ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "created_at": r["created_at"],
            "dataset": json.loads(r["report"])["dataset"],
        }
        for r in rows
    ]


@app.get("/experiments/{experiment_id}")
def get_experiment(experiment_id: int):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM experiments WHERE id=?", (experiment_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "Experiment not found")
    return unpack(row, ["report"])


@app.delete("/experiments/{experiment_id}")
def delete_experiment(experiment_id: int):
    with db() as conn:
        if not conn.execute(
            "DELETE FROM experiments WHERE id=?", (experiment_id,)
        ).rowcount:
            raise HTTPException(404, "Experiment not found")
    return {"deleted": experiment_id}


@app.get("/")
def index():
    return FileResponse(ROOT / "index.html")


PUBLIC_FILES = {
    "index.html",
    "signal_bot.html",
    "styles.css",
    "favicon.svg",
    "app.js",
    "engine.js",
    "research-worker.js",
}


@app.get("/{asset}")
def asset(asset: str):
    if asset not in PUBLIC_FILES:
        raise HTTPException(404, "Asset not found")
    return FileResponse(ROOT / asset)
