# One build, three runtime images. Each copies only the code it runs:
#   api     - control plane (all routes, database access); also runs the one-shot migration
#   agent   - Red, Blue or Target agent (no database driver, no control-plane code)
#   witness - audit checkpoint log (no database driver, no control-plane code)
FROM python:3.13-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /bin/uv
ENV UV_PYTHON_DOWNLOADS=never PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN useradd --system --uid 10001 --no-create-home bayora
COPY pyproject.toml uv.lock .python-version ./

FROM base AS deps-db
RUN uv sync --frozen --no-dev --extra postgres

FROM base AS deps
RUN uv sync --frozen --no-dev

FROM deps-db AS api
COPY app ./app
USER 10001
EXPOSE 8000
CMD [".venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

FROM deps AS agent
COPY app/__init__.py app/target.py app/providers.py app/tokens.py ./app/
COPY agents ./agents
USER 10001
EXPOSE 8000
# The compose service picks the role: agents.red_agent, agents.blue_agent or agents.target_agent.
CMD [".venv/bin/uvicorn", "agents.target_agent:app", "--host", "0.0.0.0", "--port", "8000"]

FROM deps AS witness
COPY witness ./witness
RUN mkdir /data && chown 10001:10001 /data
USER 10001
EXPOSE 8000
CMD [".venv/bin/uvicorn", "witness.app:app", "--host", "0.0.0.0", "--port", "8000"]
