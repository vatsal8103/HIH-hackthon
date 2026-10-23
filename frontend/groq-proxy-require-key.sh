#!/bin/sh
# Refuse to start groq-proxy without a key, instead of forwarding unauthenticated requests.
if [ -z "${GROQ_API_KEY:-}" ]; then
    echo "groq-proxy: GROQ_API_KEY is empty; set it in .env (it is held only by this container)" >&2
    exit 1
fi
