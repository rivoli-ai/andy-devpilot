FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# apiUrl is /api (relative) — nginx proxies /api to the backend container
RUN npm run build -- --configuration production

FROM nginx:alpine
COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

# docker-entrypoint.sh writes /assets/config.json from $API_URL before starting nginx
CMD ["/docker-entrypoint.sh"]
