# DevPilot Frontend

Angular 17 single-page application for DevPilot.

---

## Tech Stack

- **Angular 17** with standalone components
- **Signals** for reactive state management
- **RxJS** for async operations
- **TypeScript** 5.x
- **SCSS** for styling

---

## Project structure

```
src/app/
├── core/
│   ├── auth/               # OIDC config loader
│   ├── guards/             # Route guards
│   ├── interceptors/       # HTTP interceptors (JWT + sandbox token)
│   └── services/
│       ├── auth.service.ts
│       ├── repository.service.ts
│       ├── backlog.service.ts
│       ├── sandbox.service.ts
│       └── vnc-viewer.service.ts
│
├── features/
│   ├── backlog/            # Kanban backlog board + AI generation
│   ├── code/               # Code browser
│   ├── repositories/       # Repository list
│   ├── settings/           # User settings
│   └── login/              # Auth pages
│
├── components/
│   ├── vnc-viewer/         # VNC remote desktop viewer
│   └── backlog-generator/  # AI backlog modal
│
├── layout/
│   ├── sidebar/
│   └── header/
│
└── environments/
    ├── environment.ts          # Development
    └── environment.prod.ts     # Production
```

---

## Run locally (native)

### Prerequisites

- Node.js 18+ — https://nodejs.org
- npm 9+

### 1. Install dependencies

```bash
cd frontend
npm install
```

### 2. Configure the API URL

Edit `src/environments/environment.ts`:

```typescript
export const environment = {
  production: false,
  apiUrl: 'http://localhost:8080/api'
};
```

> The backend must be running on port 8080. See `backend/src/README.md`.

### 3. Start the dev server

```bash
npm start
# or
ng serve
```

App available at `http://localhost:4200`. Hot-reload on file changes.

---

## Run with Docker

> No Dockerfile exists yet. Here is what to create as `frontend/Dockerfile`:

```dockerfile
# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build -- --configuration production

# Serve stage
FROM nginx:alpine
COPY --from=build /app/dist/devpilot/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

You also need a `frontend/nginx.conf` to support Angular routing and proxy the API:

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  # Angular routing — fallback to index.html
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Proxy API calls to backend (optional — use if frontend and backend share the same domain)
  location /api {
    proxy_pass http://devpilot-backend:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

Build and run:

```bash
docker build -t devpilot-frontend:local frontend/

docker run -d \
  --name devpilot-frontend \
  -p 4200:80 \
  devpilot-frontend:local
```

> For the production build the `apiUrl` in `environment.prod.ts` is `/api` (relative),
> which works when nginx proxies `/api` to the backend on the same domain.
> If the frontend and backend are on separate domains, change it to the absolute backend URL.

---

## Deploy to Kubernetes / AKS

### What you need to create (no manifests exist yet)

1. **Build and push** the frontend image:

```bash
docker build -t ghcr.io/YOUR_ORG/devpilot-frontend:latest frontend/
docker push ghcr.io/YOUR_ORG/devpilot-frontend:latest
```

2. **Create a Deployment + Service** manifest (`infra/k8s/manifests/frontend-deployment.yaml`):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: devpilot-frontend
  namespace: devpilot
spec:
  replicas: 1
  selector:
    matchLabels:
      app: devpilot-frontend
  template:
    metadata:
      labels:
        app: devpilot-frontend
    spec:
      containers:
      - name: frontend
        image: ghcr.io/YOUR_ORG/devpilot-frontend:latest
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: devpilot-frontend
  namespace: devpilot
spec:
  type: ClusterIP
  selector:
    app: devpilot-frontend
  ports:
  - port: 80
    targetPort: 80
```

3. **Create an Ingress** to expose the app (requires an ingress controller like nginx-ingress on AKS):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: devpilot-ingress
  namespace: devpilot
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: devpilot.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: devpilot-frontend
            port:
              number: 80
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: devpilot-backend
            port:
              number: 8080
```

4. **Apply**:

```bash
kubectl apply -f infra/k8s/manifests/frontend-deployment.yaml
kubectl apply -f infra/k8s/manifests/ingress.yaml
```

---

## Environment configuration

| File | Used for |
|------|----------|
| `src/environments/environment.ts` | `ng serve` (local dev) |
| `src/environments/environment.prod.ts` | `ng build --configuration production` |

```typescript
// environment.ts (dev)
export const environment = {
  production: false,
  apiUrl: 'http://localhost:8080/api'
};

// environment.prod.ts (prod)
export const environment = {
  production: true,
  apiUrl: '/api'   // relative — works when nginx proxies /api to backend
};
```

> For a separate domain deployment (frontend on `app.example.com`, backend on `api.example.com`), change `apiUrl` in `environment.prod.ts` to the absolute backend URL.

---

## Build

```bash
# Development build
npm run build

# Production build
npm run build -- --configuration production
```

Output goes to `dist/devpilot/browser/`.

---

## Key services

### AuthService
Handles login, OAuth flows (GitHub, Microsoft/Azure AD), token storage.

### SandboxService
Creates and manages VPS sandbox containers via the backend API.

### VncViewerService
Manages multiple VNC viewer instances (per sandbox), stores sandbox tokens and VNC passwords, builds authenticated iframe URLs.

### BacklogService
Backlog CRUD, AI generation, Azure DevOps import.

### authInterceptor (HTTP interceptor)
Automatically adds `Authorization: Bearer <JWT>` to all backend API requests.
Skips adding JWT if the request already has an `Authorization` header (e.g. sandbox bridge requests use a per-sandbox token).

---

## Troubleshooting

### CORS errors

- Make sure the backend has CORS configured for `http://localhost:4200`
- Check `Program.cs` in the backend for the CORS policy

### OAuth callback not working

- Verify the redirect URI in `appsettings.Development.json` matches the one configured in your GitHub / Azure AD app registration
- Default: `http://localhost:4200/auth/callback/GitHub`

### Sandbox VNC blank / 401 errors

- The sandbox bearer token is per-sandbox — it is returned at sandbox creation and stored in `localStorage`
- Refreshing the page restores running sandboxes via `GET /api/sandboxes`
- If you see 401s on bridge requests, check the `authInterceptor` is not overwriting the sandbox token with the user JWT

### Build fails — cannot resolve environment

```bash
# Make sure you're running from the frontend/ directory
cd frontend
npm run build -- --configuration production
```
