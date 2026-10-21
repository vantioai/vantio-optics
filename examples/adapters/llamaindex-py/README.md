# LlamaIndex (Python) + Vantio Optics

LlamaIndex uses `httpx` — use the Python SDK `@shield` decorator (same as LangChain Python).

```bash
pip install 'vantio-agent-sdk==3.1.1' llama-index
```

```python
from llama_index.llms.openai import OpenAI
from vantio import shield

@shield
async def ask(q: str):
    llm = OpenAI(model="gpt-4o-mini")
    return await llm.acomplete(q)
```

Fence: observe. Enforcement is Phantom Engine on Linux systems you enroll, and that product is not in this repository. Python `shield()` in the current PyPI release records urllib and, when installed, httpx — which LlamaIndex uses. Pin `vantio-agent-sdk==3.1.1` (checked 2026-10-21).
