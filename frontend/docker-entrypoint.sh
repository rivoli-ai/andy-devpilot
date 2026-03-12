#!/bin/sh
# Generate /assets/config.json at container startup from environment variables.
# This replaces the build-time environment.ts so the same image works in any environment.
cat > /usr/share/nginx/html/assets/config.json <<EOF
{
  "apiUrl": "${API_URL:-/api}"
}
EOF

exec nginx -g "daemon off;"
