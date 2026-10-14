"""Small, server-only Gemini client shared by AI assistance features."""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def _load_env_file(path):
    """Load key=value pairs from a .env / desktop.env file into os.environ (no-overwrite)."""
    try:
        with open(path, encoding='utf-8') as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                k = k.strip()
                if k and k not in os.environ:
                    os.environ[k] = v.strip().strip('"').strip("'")
    except Exception:
        pass


# Search order: dev .env files → installed resources desktop.env → exe-adjacent desktop.env
# When installed via NSIS: exe is at resources/backend/vtab-backend.exe
#                           desktop.env is at resources/desktop.env  (parent of parent)
_search_paths = [
    # Development: api/.env and project-root .env
    Path(__file__).parent.parent / '.env',
    Path(__file__).parent.parent.parent / '.env',
    # PyInstaller installed — desktop.env is 2 levels above the exe
    Path(sys.executable).parent.parent / 'desktop.env',
    # Same directory as exe (alternate packaging)
    Path(sys.executable).parent / 'desktop.env',
    # 3 levels up (extra fallback)
    Path(sys.executable).parent.parent.parent / 'desktop.env',
]
for _env_path in _search_paths:
    if _env_path.exists():
        _load_env_file(_env_path)


MODEL = os.environ.get('VTAB_GEMINI_MODEL', 'gemini-2.5-flash')
TIMEOUT_SECONDS = 60
RETRIES = 4


class GeminiError(ValueError):
    pass


def generate(prompt: str, system_instruction: str, *, json_response: bool = False) -> str:
    # Try env var (set by Electron or loaded from desktop.env on startup)
    api_key = os.environ.get('VTAB_GEMINI_API_KEY', '').strip()
    if not api_key:
        raise GeminiError('Gemini is not configured. Set VTAB_GEMINI_API_KEY on the backend.')
    payload = {
        'contents': [{'parts': [{'text': prompt}]}],
        'systemInstruction': {'parts': [{'text': system_instruction}]},
        'generationConfig': {'temperature': 0.1, **({'responseMimeType': 'application/json'} if json_response else {})},
    }
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={api_key}'
    body = json.dumps(payload).encode('utf-8')
    last_error: Exception | None = None
    for attempt in range(RETRIES):
        try:
            request = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                result = json.loads(response.read().decode('utf-8'))
            return result['candidates'][0]['content']['parts'][0]['text'].strip()
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code == 429:
                # Rate limited — use exponential backoff: 5s, 10s, 20s
                if attempt < RETRIES - 1:
                    time.sleep(5 * (2 ** attempt))
            elif attempt < RETRIES - 1:
                time.sleep(1.5 * (attempt + 1))
        except (urllib.error.URLError, KeyError, IndexError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < RETRIES - 1:
                time.sleep(1.5 * (attempt + 1))
    raise GeminiError(f'AI generation failed (Gemini) request failed after {RETRIES} attempts: {last_error}')


def generate_json(prompt: str, system_instruction: str) -> dict:
    text = generate(prompt, system_instruction, json_response=True)
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else ''
        if text.endswith('```'):
            text = text[:-3]
    try:
        value = json.loads(text.strip())
    except json.JSONDecodeError as exc:
        raise GeminiError('Gemini returned invalid JSON.') from exc
    if not isinstance(value, dict):
        raise GeminiError('Gemini returned an invalid response object.')
    return value
