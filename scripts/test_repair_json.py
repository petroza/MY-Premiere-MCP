"""Test opravy uříznutého JSON z lokálního LLM: .venv\\Scripts\\python.exe scripts\\test_repair_json.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from worker.gpu import repair_json  # noqa: E402

cases = [
    ('{"picks":[{"id":1,"priority":1},{"id":2,"prio', {"picks": [{"id": 1, "priority": 1}]}),
    ('text před {"scores":[{"k":1,"score":3,"why":"jádro, \\"citace\\""}]} za', {"scores": [{"k": 1, "score": 3, "why": 'jádro, "citace"'}]}),
    ('{"chapters":[{"from":1,"to":5,"title":"Úvod"},{"from":6', {"chapters": [{"from": 1, "to": 5, "title": "Úvod"}]}),
    ("nic", {}),
]
ok = True
for raw, want in cases:
    got = repair_json(raw)
    print("OK " if got == want else "CHYBA", raw[:50], "->", got)
    ok &= got == want
sys.exit(0 if ok else 1)
