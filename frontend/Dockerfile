FROM node:20-alpine AS build
WORKDIR /app

# Relax SSL for npm/node during build to survive corporate proxies / custom CAs.
# (At runtime, the frontend is just static files served by nginx.)
ENV NODE_TLS_REJECT_UNAUTHORIZED=0 \
    NPM_CONFIG_STRICT_SSL=false \
    npm_config_strict-ssl=false

COPY package*.json ./
RUN npm config set strict-ssl false && \
    npm ci

COPY . .
# apiUrl is /api (relative) — nginx proxies /api to the backend container
RUN npm config set strict-ssl false && \
    npm run build -- --configuration production

FROM nginx:alpine
COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

# docker-entrypoint.sh writes /assets/config.json from $API_URL before starting nginx
CMD ["/docker-entrypoint.sh"]
