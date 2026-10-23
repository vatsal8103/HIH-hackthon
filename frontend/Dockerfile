# Credential-free TCP relay for the published port (see relay.conf). Built only with target: relay.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS relay
COPY relay.conf /etc/nginx/nginx.conf

# Live AI only (compose profile "live"): the target's restricted path to Ollama. See ollama-proxy.conf.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS ollama-proxy
COPY ollama-proxy.conf /etc/nginx/nginx.conf

# Live AI via Groq only (compose profile "groq"): holds the key, forwards two endpoints to api.groq.com.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS groq-proxy
COPY groq-proxy.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 groq-proxy-require-key.sh /docker-entrypoint.d/05-require-key.sh

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Unprivileged nginx (uid 101, port 8080). The operator credential is injected into the
# proxy config at container start from the environment; the bundle never contains it.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS app
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
