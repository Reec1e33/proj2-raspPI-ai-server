# syntax=docker/dockerfile:1

# Build on the native platform and cross-compile for the target. Go needs
# no emulation for this, so multi-arch builds stay fast.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
ARG TARGETOS TARGETARCH TARGETVARIANT
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOARM=${TARGETVARIANT#v} \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
      -o /out/pi-agent ./cmd/pi-agent

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/pi-agent /usr/local/bin/pi-agent
USER nonroot:nonroot
EXPOSE 9110
# Distroless has no shell or curl; the binary probes its own /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/pi-agent", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/pi-agent"]
