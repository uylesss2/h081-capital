# Pinned build image for verifiable builds of the four production programs.
# Toolchain (must match solana/scripts/verifiable-build.sh and solana/README.md):
#   Solana CLI 4.3.2 (Agave, ships cargo-build-sbf 4.4.0), platform-tools v1.57, host rustc 1.99.1.
#
#   docker build -t h081-sbf:4.3.2 solana/verify
#   docker run --rm -v "$PWD":/repo:ro -v "$PWD/solana/target-verifiable":/out h081-sbf:4.3.2 \
#     bash /repo/solana/scripts/verifiable-build.sh --out /out
#
# Pin the base image by digest for a release: replace BASE with ubuntu:24.04@sha256:<digest> (from
# `docker buildx imagetools inspect ubuntu:24.04`) and record that digest next to the published hashes in
# the release notes. The tag alone is not immutable. The image never sees a key and never talks to a cluster.
ARG BASE=ubuntu:24.04
FROM ${BASE}

ARG RUST_VERSION=1.99.1
ARG SOLANA_VERSION=4.3.2
ARG PLATFORM_TOOLS=v1.57

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/opt/rustup \
    PATH=/opt/cargo/bin:/opt/solana/active_release/bin:$PATH \
    LANG=C.UTF-8 \
    TZ=UTC

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git bzip2 build-essential pkg-config \
      libssl-dev libudev-dev python3 \
 && rm -rf /var/lib/apt/lists/*

# Host Rust (build scripts and proc macros run on the host compiler).
RUN curl -sSf https://sh.rustup.rs | CARGO_HOME=/opt/cargo sh -s -- -y --profile minimal \
      --default-toolchain "${RUST_VERSION}" --no-modify-path \
 && rustc --version

# Agave release with cargo-build-sbf, installed to a fixed prefix.
RUN curl -sSfL "https://release.anza.xyz/v${SOLANA_VERSION}/install" -o /tmp/agave-install.sh \
 && sh /tmp/agave-install.sh --data-dir /opt/solana \
 && rm /tmp/agave-install.sh \
 && solana --version && cargo-build-sbf --version

# platform-tools, fetched once into the image so builds run with the same compiler every time.
RUN CARGO_HOME=/opt/cargo cargo-build-sbf --install-only --tools-version "${PLATFORM_TOOLS}"

# The repository is mounted read-only; git needs to be told it may read it.
RUN git config --global --add safe.directory '*'
WORKDIR /repo
