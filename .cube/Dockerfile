# syntax=docker/dockerfile:1.7

# Adapted from shekohex/cubesandbox-pve@774d85b8c4aa06d63085845ff064efe26aec00b6.
ARG CUBE_BASE_IMAGE=bbcr.0iq.xyz/hakim/cube-hakim-js:71a7eaf6d746-20260917122636

FROM ${CUBE_BASE_IMAGE}

ARG DOTAI_REF
ARG PASEO_VERSION=0.8.0
ARG CODEX_VERSION=0.154.0
ARG GH_VERSION=2.95.0
ARG GH_SHA256=25d1e4729e8808c9ed3d613e96ebd3f3e44446f2d368c89d878a71a36ddb3d8c

LABEL io.dotai.runtime-ref="${DOTAI_REF}"

USER coder
RUN set -eux; \
    printf '%s' "${DOTAI_REF}" | grep -Eq '^[0-9a-f]{40}$' || { echo "DOTAI_REF must be an exact 40-character lowercase commit SHA" >&2; exit 2; }; \
    bun add --global "@getpaseo/cli@${PASEO_VERSION}"; \
    curl -fsSL https://chatgpt.com/codex/install.sh -o /tmp/codex-install.sh; \
    CODEX_HOME=/home/coder/.codex \
      CODEX_INSTALL_DIR=/home/coder/.local/bin \
      CODEX_NON_INTERACTIVE=true \
      sh /tmp/codex-install.sh --release "${CODEX_VERSION}"; \
    rm -f /tmp/codex-install.sh

USER root
RUN set -eux; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tar.gz; \
    printf '%s  %s\n' "${GH_SHA256}" /tmp/gh.tar.gz | sha256sum --check --strict; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64"; \
    rm -rf /root/.config/gh /root/.paseo; \
    rm -f /root/.gitconfig /root/.git-credentials /root/.codex/auth.json; \
    install -d -o coder -g coder -m 0755 /workspace; \
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'cd /workspace/dotai/agent' 'exec npm run pi -- "$@"' > /usr/local/bin/pi; \
    chmod 0755 /usr/local/bin/pi; \
    ln -sf /home/coder/.bun/bin/paseo /usr/local/bin/paseo; \
    ln -sf /home/coder/.local/bin/codex /usr/local/bin/codex; \
    rm -rf /home/coder/.bun/install/cache

USER coder
RUN test -x "$(command -v pi)" && \
    gh --version | head -n 1 | grep -F "gh version ${GH_VERSION} " && \
    paseo --version | grep -Fx '0.8.0' && \
    codex --version | grep -Fx 'codex-cli 0.154.0' && \
    test ! -e /home/coder/.config/gh/hosts.yml && \
    test ! -e /home/coder/.dotai && \
    test ! -e /workspace/dotai && \
    test ! -e /home/coder/.pi/agent/auth.json && \
    test ! -e /home/coder/.codex/auth.json && \
    test ! -e /home/coder/.paseo && \
    test -z "$(find /home/coder/.ssh -type f -print -quit 2>/dev/null || true)" && \
    test -z "$(git config --global --get credential.helper || true)" && \
    test -z "$(git config --global --get user.name || true)" && \
    test -z "$(git config --global --get user.email || true)" && \
    test -z "$(git config --global --get gpg.format || true)" && \
    test -z "$(git config --global --get commit.gpgsign || true)" && \
    test -z "$(git config --global --get user.signingkey || true)" && \
    test -z "$(git config --global --get core.sshCommand || true)" && \
    test -z "${ANTHROPIC_API_KEY:-}${CODEX_API_KEY:-}${GEMINI_API_KEY:-}${GH_TOKEN:-}${GITHUB_TOKEN:-}${OPENAI_API_KEY:-}"

USER root
RUN test -z "$(find /home/coder/.ssh /root/.ssh -type f -print -quit 2>/dev/null || true)" && \
    test ! -e /root/.gitconfig && \
    test ! -e /root/.git-credentials && \
    test ! -e /root/.config/gh/hosts.yml

WORKDIR /workspace

# Cube adapter health remains on inherited port 49983. It is not an app preview.
# Preserve Cube adapter entrypoint, CMD, and root runtime user.
