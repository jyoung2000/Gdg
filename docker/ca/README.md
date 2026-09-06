# Build-time certificate authorities

Drop a PEM-encoded CA certificate here (`*.crt` or `*.pem`) if your organisation's
egress proxy terminates TLS. The build adds every certificate in this directory
to the image's trust store and points `NODE_EXTRA_CA_CERTS` at it, so `pnpm
install` can reach the registry through the proxy without anyone disabling
certificate verification.

Nothing is required. An empty directory changes nothing about the build.

Certificates are deliberately not committed: they belong to the environment, not
to Meridian. `docker/ca/*.crt` and `*.pem` are git-ignored.
