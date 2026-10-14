import sqlite3
import json

conn = sqlite3.connect('data/studio_meta.db')
c = conn.cursor()
tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
print("Tables:", tables)

for t in tables:
    count = c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    print(f"Table {t}: {count} rows")

for row in c.execute("SELECT id, name FROM saved_reports"):
    print("saved_report:", row)
for row in c.execute("SELECT id, name FROM projects"):
    print("project:", row)
