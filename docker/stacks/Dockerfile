FROM rust:bookworm AS builder

# This will be overridden by the value from docker-compose
# Accepts a branch, tag, or full commit SHA reachable in
# stacks-network/stacks-core.
ARG STACKS_CORE_BASE_BRANCH=master

RUN echo "Building Stacks Core from: $STACKS_CORE_BASE_BRANCH"

RUN git init /code/stacks-core && \
    cd /code/stacks-core && \
    git remote add origin https://github.com/stacks-network/stacks-core.git && \
    git fetch --depth=1 origin $STACKS_CORE_BASE_BRANCH && \
    git checkout FETCH_HEAD

WORKDIR /code/stacks-core
RUN apt-get update && apt-get install -y libclang-dev llvm

# Run an build that we'll cache the result of and then build the code
RUN cargo build --features monitoring_prom,slog_json --bin stacks-node --bin stacks-signer

FROM debian:bookworm-slim AS stacks-node
RUN apt-get update \
    && apt-get install -y ca-certificates --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN mkdir /data
COPY --from=builder /code/stacks-core/target/debug/stacks-node /usr/local/bin/stacks-node
STOPSIGNAL SIGTERM

FROM debian:bookworm-slim AS stacks-signer
RUN apt-get update \
    && apt-get install -y ca-certificates --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN mkdir /data
COPY --from=builder /code/stacks-core/target/debug/stacks-signer /usr/local/bin/stacks-signer
STOPSIGNAL SIGTERM
