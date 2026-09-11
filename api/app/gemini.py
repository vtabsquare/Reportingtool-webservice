"""Small, server-only Gemini client shared by AI assistance features."""
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

# Naive .env loader for local development (when run via uvicorn directly)
for _env_path in [Path(__file__).parent.parent / '.env', Path(__file__).parent.parent.parent / '.env']:
    if _env_path.exists():
        with open(_env_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, _, v = line.partition('=')
                    k = k.strip()
                    if k and k not in os.environ:
                        os.environ[k] = v.strip().strip('"').strip("'")

MODEL = os.environ.get('VTAB_GEMINI_MODEL', 'gemini-2.5-flash')
TIMEOUT_SECONDS = 60
RETRIES = 3


class GeminiError(ValueError):
    pass


def generate(prompt: str, system_instruction: str, *, json_response: bool = False) -> str:
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
        except (urllib.error.URLError, urllib.error.HTTPError, KeyError, IndexError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < RETRIES - 1:
                time.sleep(1.5 * (attempt + 1))
    raise GeminiError(f'Gemini request failed after {RETRIES} attempts: {last_error}')


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
