import sys
from pathlib import Path

# Make repo root importable (mirrors the sys.path.insert pattern in jobs)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
