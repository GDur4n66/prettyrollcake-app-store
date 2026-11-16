# Optional container build. The relay runs the same way without Docker:
#   go build -o lnproxy-relay ./cmd/http-relay
FROM --platform=$BUILDPLATFORM golang:1.26-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=$(cat VERSION)" -o /out/lnproxy-relay ./cmd/http-relay

FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
COPY --from=build /out/lnproxy-relay /usr/local/bin/lnproxy-relay
# Listen on all interfaces inside the container and keep state in /data.
ENV LNPROXY_HOST=0.0.0.0 \
    LNPROXY_PORT=4747 \
    LNPROXY_DB=/data/lnproxy-relay.db
USER 1000:1000
EXPOSE 4747
ENTRYPOINT ["/usr/local/bin/lnproxy-relay"]
