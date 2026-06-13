# ============================================================================
# CodePilot sandbox image — the environment agent commands run inside.
# Node.js 20, Python 3.12, PHP 8.3, Go 1.23, Rust stable, plus git and the
# usual build tooling. Runs as the unprivileged "sandbox" user.
#
# Build:  docker build -t codepilot-sandbox:latest .
# ============================================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# --- base tooling + Python 3.12 + PHP 8.3 (Ubuntu 24.04 defaults) -----------
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client gnupg xz-utils unzip zip \
      build-essential pkg-config procps jq ripgrep \
      python3 python3-pip python3-venv \
      php-cli php-mbstring php-xml php-curl php-zip php-sqlite3 composer \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js 20 (NodeSource) -------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm yarn \
    && rm -rf /var/lib/apt/lists/*

# --- Go 1.23 ------------------------------------------------------------------
ARG GO_VERSION=1.23.4
RUN ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tgz \
    && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
ENV PATH="/usr/local/go/bin:${PATH}"

# --- non-root user -------------------------------------------------------------
# Ubuntu 24.04 ships a default "ubuntu" user at uid 1000; replace it.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -u 1000 -s /bin/bash sandbox \
    && mkdir -p /workspace && chown sandbox:sandbox /workspace

USER sandbox
WORKDIR /home/sandbox

# --- Rust (per-user toolchain, as recommended) ---------------------------------
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/home/sandbox/.cargo/bin:/usr/local/go/bin:${PATH}" \
    GOPATH="/home/sandbox/go" \
    PIP_BREAK_SYSTEM_PACKAGES=1

# Sensible git defaults; identity is overridden per-commit by the runner.
RUN git config --global init.defaultBranch main \
    && git config --global advice.detachedHead false \
    && git config --global --add safe.directory /workspace

WORKDIR /workspace
CMD ["sleep", "infinity"]
