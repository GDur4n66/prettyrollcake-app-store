# Frigate (Sparrow Wallet's Silent Payments Electrum server) from the
# official release tarball, plus a small status page.
#
#   python3 -I /app/frigateapp.py
#     writes config.toml on first start, runs Frigate as a child process and
#     serves the status page on :50012 (it reads Frigate's stdout and the
#     loopback-only admin port, so both have to live in this container).

ARG FRIGATE_VERSION=1.6.1
# sha256 from frigate-1.6.1-manifest.txt (signed by Craig Raw, D4D0D320 2FC06849 A257B38D E9461833 4C674B40)
ARG FRIGATE_SHA256_AMD64=ebddc2f7396035459dd94c8e04bfdccf2332506d907f949d67351fb47c6fbc2f
ARG FRIGATE_SHA256_ARM64=32d97ebc74581cee101fe8a03613e1de4b59ddd03ff46553bf17702a4eea72f5

FROM --platform=$BUILDPLATFORM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f AS download
ARG FRIGATE_VERSION
ARG FRIGATE_SHA256_AMD64
ARG FRIGATE_SHA256_ARM64
ARG TARGETARCH
RUN apk add --no-cache curl
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) arch=x86_64;  sum="${FRIGATE_SHA256_AMD64}" ;; \
      arm64) arch=aarch64; sum="${FRIGATE_SHA256_ARM64}" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/frigate.tar.gz \
      "https://github.com/sparrowwallet/frigate/releases/download/${FRIGATE_VERSION}/frigate-${FRIGATE_VERSION}-${arch}.tar.gz"; \
    echo "${sum}  /tmp/frigate.tar.gz" | sha256sum -c -; \
    mkdir -p /out; \
    tar -xzf /tmp/frigate.tar.gz -C /out; \
    test -x /out/frigate/bin/frigate

FROM ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5
ARG TARGETARCH
ARG FRIGATE_VERSION

# intel-opencl-icd lets Frigate scan on the Intel GPU of Umbrel Home (amd64).
# Without a usable GPU, computeBackend = "AUTO" falls back to the CPU.
RUN set -eu; \
    extra=""; \
    if [ "${TARGETARCH}" = "amd64" ]; then extra="intel-opencl-icd"; fi; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      ca-certificates libstdc++6 ocl-icd-libopencl1 python3 ${extra}; \
    rm -rf /var/lib/apt/lists/*

COPY --from=download /out/frigate /opt/frigate
COPY frigateapp.py /app/
COPY web /web

ENV HOME=/data \
    FRIGATE_VERSION=${FRIGATE_VERSION} \
    WEB_DIR=/web \
    PORT=50012

USER 1000:1000
WORKDIR /data
EXPOSE 50011 50012
CMD ["python3", "-I", "/app/frigateapp.py"]
