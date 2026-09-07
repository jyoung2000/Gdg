# Base is parameterized for restricted-egress environments (Docker Hub may be
# unreachable); default remains the standard node image.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}
WORKDIR /app
COPY server.js .
EXPOSE 3000
HEALTHCHECK --interval=3s --timeout=3s --start-period=2s --retries=5 \
  CMD ["node", "-e", "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
