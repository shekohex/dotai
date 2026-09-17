# syntax=docker/dockerfile:1.7

# Adapted from shekohex/cubesandbox-pve@774d85b8c4aa06d63085845ff064efe26aec00b6.
ARG CUBE_BASE_IMAGE=bbcr.0iq.xyz/hakim/cube-hakim-js:80671b59cec6-20260916180402@sha256:9b06483a09d0bdf3115b6efcf77473357d305ec4db57a6122871d3f93bce7637

FROM ${CUBE_BASE_IMAGE}

ARG DOTAI_REF
ARG PASEO_VERSION=0.8.0
ARG CODEX_VERSION=0.154.0
ARG GH_VERSION=2.101.0
ARG GH_LINUX_AMD64_SHA256=9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8

USER root
RUN set -eux; \
    archive="gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    curl -fsSLo "/tmp/${archive}" "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${archive}"; \
    echo "${GH_LINUX_AMD64_SHA256}  /tmp/${archive}" | sha256sum --check --strict; \
    tar -xzf "/tmp/${archive}" -C /tmp; \
    install -o root -g root -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf "/tmp/${archive}" "/tmp/gh_${GH_VERSION}_linux_amd64"

USER coder
RUN bun add --global \
      "@getpaseo/cli@${PASEO_VERSION}" \
      "@openai/codex@${CODEX_VERSION}"

RUN --mount=type=secret,id=github_token,required=true,uid=1000,mode=0400 \
    set -eu; \
    printf '%s' "${DOTAI_REF}" | grep -Eq '^[0-9a-f]{40}$' || { echo "DOTAI_REF must be an exact 40-character lowercase commit SHA" >&2; exit 2; }; \
    export GH_TOKEN="$(cat /run/secrets/github_token)"; \
    authorization="$(printf 'x-access-token:%s' "${GH_TOKEN}" | base64 | tr -d '\n')"; \
    git init /home/coder/.dotai; \
    git -C /home/coder/.dotai remote add origin https://github.com/shekohex/dotai.git; \
    git -C /home/coder/.dotai -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${authorization}" fetch --depth 1 origin "${DOTAI_REF}"; \
    git -C /home/coder/.dotai checkout --detach FETCH_HEAD; \
    test "$(git -C /home/coder/.dotai rev-parse HEAD)" = "${DOTAI_REF}"; \
    cd /home/coder/.dotai; \
    ./install.sh --yes; \
    sed -i 's#/home/coder/dotai#/workspace/dotai#g' /home/coder/.codex/config.toml; \
    cd /; \
    rm -rf /home/coder/.dotai /home/coder/.config/gh /home/coder/.paseo; \
    rm -f /home/coder/.gitconfig /home/coder/.git-credentials /home/coder/.pi/agent/auth.json /home/coder/.codex/auth.json; \
    test ! -e /home/coder/.pi/agent/auth.json; \
    test ! -e /home/coder/.codex/auth.json; \
    test ! -e /home/coder/.git-credentials; \
    test ! -e /home/coder/.config/gh/hosts.yml; \
    test ! -e /home/coder/.paseo; \
    test ! -e /workspace/dotai

USER root
RUN set -eux; \
    rm -rf /root/.config/gh /root/.paseo; \
    rm -f /root/.gitconfig /root/.git-credentials /root/.codex/auth.json; \
    install -d -o coder -g coder -m 0755 /workspace; \
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'cd /workspace/dotai/agent' 'exec npm run pi -- "$@"' > /usr/local/bin/pi; \
    chmod 0755 /usr/local/bin/pi; \
    ln -sf /home/coder/.bun/bin/paseo /usr/local/bin/paseo; \
    ln -sf /home/coder/.bun/bin/codex /usr/local/bin/codex; \
    rm -rf /home/coder/.bun/install/cache

USER coder
RUN test -x "$(command -v pi)" && \
    gh --version >/dev/null && \
    paseo --version | grep -Fx '0.8.0' && \
    codex --version | grep -Fx 'codex-cli 0.154.0' && \
    test ! -e /home/coder/.config/gh/hosts.yml && \
    test -z "$(git config --global --get credential.helper || true)" && \
    test -z "$(git config --global --get user.name || true)" && \
    test -z "$(git config --global --get user.email || true)" && \
    test -z "${ANTHROPIC_API_KEY:-}${CODEX_API_KEY:-}${GEMINI_API_KEY:-}${GH_TOKEN:-}${GITHUB_TOKEN:-}${OPENAI_API_KEY:-}"

USER root
WORKDIR /workspace

# Cube adapter health remains on inherited port 49983. It is not an app preview.
# Preserve Cube adapter entrypoint, CMD, and root runtime user.
