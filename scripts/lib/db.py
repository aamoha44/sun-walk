"""authoring.db — connection + bootstrap for the Tier 1 authoring database.

Spec: contracts/authoring.sql,
      docs/specs/11-system-architecture.md §3.

`authoring.db` is a DERIVED, gitignored artifact (it lives under build/).
It is NEVER migrated — a schema change means editing authoring.sql and
rebuilding from scratch: delete the file and call connect() again.

Every connection MUST go through connect(), which:
  * loads mod_spatialite                                    (11 §3.4)
  * PRAGMA foreign_keys = ON   — SQLite defaults it OFF, silently. K-03.
  * PRAGMA journal_mode = WAL
  * on a fresh file: SELECT InitSpatialMetaData(1), then runs authoring.sql

Stdlib only. Requires a SpatiaLite-capable interpreter — on this machine that
is the MSYS2 UCRT64 python (C:\\msys64\\ucrt64\\bin\\python3.exe), NOT the bare
Windows python.exe / py -3, which cannot load mod_spatialite.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "contracts" / "authoring.sql"
DEFAULT_DB_PATH = REPO_ROOT / "build" / "authoring.db"

_SPATIALITE_LIB = "mod_spatialite"
_MEMORY = ":memory:"


class SpatialiteUnavailable(RuntimeError):
    """mod_spatialite could not be loaded — almost always the wrong interpreter."""


def _is_memory(db_path: str | Path) -> bool:
    return str(db_path) == _MEMORY


def _load_spatialite(con: sqlite3.Connection) -> None:
    con.enable_load_extension(True)
    try:
        con.execute("SELECT load_extension(?)", (_SPATIALITE_LIB,))
    except sqlite3.OperationalError as exc:
        raise SpatialiteUnavailable(
            f"could not load {_SPATIALITE_LIB!r}: {exc}. "
            "Use a SpatiaLite-capable interpreter "
            r"(C:\msys64\ucrt64\bin\python3.exe), not the bare Windows python.exe / py -3."
        ) from exc
    finally:
        con.enable_load_extension(False)


def connect(db_path: str | Path = DEFAULT_DB_PATH, *, schema_path: Path = SCHEMA_PATH) -> sqlite3.Connection:
    """Open (creating + bootstrapping if needed) the authoring database.

    Pass ``":memory:"`` for a throwaway in-process database — always treated as
    fresh, so the full schema is loaded.
    """
    memory = _is_memory(db_path)
    fresh = memory or not Path(db_path).exists()
    if not memory:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    # isolation_level=None → autocommit: PRAGMA foreign_keys is a no-op inside a
    # transaction, and executescript() issues an implicit COMMIT, so the
    # connection must not be sitting in an open transaction while we bootstrap.
    con = sqlite3.connect(str(db_path), isolation_level=None)
    con.execute("PRAGMA foreign_keys = ON")   # K-03 — off by default
    con.execute("PRAGMA journal_mode = WAL")
    _load_spatialite(con)

    if fresh:
        con.execute("SELECT InitSpatialMetaData(1)")
        con.executescript(schema_path.read_text(encoding="utf-8"))
        con.execute("PRAGMA foreign_keys = ON")  # re-assert after the implicit COMMIT

    (fk_on,) = con.execute("PRAGMA foreign_keys").fetchone()
    if not fk_on:
        raise RuntimeError(
            "PRAGMA foreign_keys did not stick — foreign keys would be silently "
            "unenforced (K-03). Check that connect() runs in autocommit mode."
        )
    return con


def _check() -> int:
    """`python scripts/lib/db.py --check` — the T-031 DoD, self-contained.

    Bootstraps an in-memory authoring.db and asserts (a) SpatiaLite is live,
    (b) InitSpatialMetaData ran, (c) an edge with a dangling from_node_id is
    rejected by the foreign key. Exit 0 = all three hold; exit 1 names the one
    that failed.
    """
    con = connect(_MEMORY)

    (spatialite_ver,) = con.execute("SELECT spatialite_version()").fetchone()

    meta = con.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='geometry_columns'"
    ).fetchone()[0]
    if not meta:
        print("CHECK FAIL: InitSpatialMetaData did not create geometry_columns")
        return 1

    con.execute("INSERT INTO node(node_id, type) VALUES ('node:aaaaaaaaaa', 'walkway')")
    try:
        con.execute(
            "INSERT INTO edge(edge_id, from_node_id, to_node_id, type, length_m, "
            "surface, shade_index, shade_source) VALUES "
            "('edge:zzzzzzzzzz', 'node:aaaaaaaaaa', 'node:doesnotexist', 'path', 10, "
            "'paved', 0.5, 'default')"
        )
    except sqlite3.IntegrityError as exc:
        print(f"K-03 OK: dangling from_node_id rejected ({exc}); SpatiaLite {spatialite_ver}")
        return 0

    print("K-03 FAIL: an edge with a dangling from_node_id was accepted — foreign_keys is OFF")
    return 1


if __name__ == "__main__":
    if "--check" in sys.argv[1:]:
        raise SystemExit(_check())
    print(__doc__)
    raise SystemExit("db.py is a library; run with --check for the self-test.")
