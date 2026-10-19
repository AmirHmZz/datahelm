FROM rust:1.98-bookworm AS backend
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY backend/ ./backend/
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target cargo build --release --locked && cp target/release/datahelm /build/datahelm && /build/datahelm --openapi > /build/openapi.json

FROM oven/bun:1 AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
COPY --from=backend /build/openapi.json /build/openapi.json
RUN bun run types && bun run build

FROM backend AS test
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target cargo test --release --locked

FROM debian:bookworm-slim
ARG DATAHELM_VERSION=dev
ARG DATAHELM_REVISION=unknown
LABEL org.opencontainers.image.title="DataHelm" \
      org.opencontainers.image.description="Self-hosted MongoDB administration dashboard" \
      org.opencontainers.image.source="https://github.com/AmirHmZz/datahelm" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$DATAHELM_VERSION \
      org.opencontainers.image.revision=$DATAHELM_REVISION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && useradd -u 10001 -m datahelm && mkdir -p /data /var/lib/datahelm/secrets && chown datahelm /data /var/lib/datahelm/secrets && chmod 700 /var/lib/datahelm/secrets
WORKDIR /app
COPY --from=backend /build/datahelm /usr/local/bin/datahelm
COPY --from=frontend /build/frontend/dist /app/frontend/dist
USER datahelm
ENV DATAHELM_BIND=0.0.0.0:8080 DATAHELM_DATABASE_URL=sqlite:///data/datahelm.db DATAHELM_RUNTIME_DIR=/run/datahelm DATAHELM_SECRETS_DIR=/var/lib/datahelm/secrets
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://127.0.0.1:8080/health || exit 1
CMD ["datahelm"]

