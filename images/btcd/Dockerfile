# btcd built from the tagged source, plus a small status/settings UI.
# The same image runs both services of the app:
#   btcd: python -I /app/btcdapp.py launcher (builds the btcd flags from settings.json)
#   web:  python -I /app/btcdapp.py web      (status page and settings)

ARG BTCD_VERSION=v0.27.0
ARG BTCD_COMMIT=dd169fe0c32a56087d28b92fff3b8cf4fb43477a

# Build on the host platform and cross-compile, so arm64 needs no emulation.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS build
ARG BTCD_VERSION
ARG BTCD_COMMIT
ARG TARGETOS
ARG TARGETARCH
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${BTCD_VERSION}" https://github.com/btcsuite/btcd.git /src \
 && test "$(git -C /src rev-parse HEAD)" = "${BTCD_COMMIT}"
WORKDIR /src
RUN CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    go build -trimpath -ldflags="-s -w" -o /out/ . ./cmd/btcctl

FROM python:3.12-alpine@sha256:e064671ca452259bab50e8e2c7bd896e39e9a343bb06ca25234adf6fe18d0fc7

COPY --from=build /out/btcd /out/btcctl /usr/local/bin/
COPY btcdapp.py /app/
COPY web /web

ENV BTCD_DIR=/data/btcd \
    SETTINGS_FILE=/data/settings.json \
    WEB_DIR=/web \
    PORT=8080

USER 1000:1000
EXPOSE 8080 8333 8334
CMD ["python", "-I", "/app/btcdapp.py", "web"]
