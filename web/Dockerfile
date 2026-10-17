# The web app for a deployment: built once, served by nginx, with /api passed
# to the gateway — one origin, so a session cookie works and no CORS is needed.
#
# Built WITHOUT VITE_COMMONINDEX_TOKEN: a token in a Vite variable is baked into the
# bundle for anyone who loads it. People sign in (docs/sign-in.md).
FROM node:22-slim AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY . .
# Empty: the API is on this same origin, under /api.
ENV VITE_GATEWAY_URL=""
RUN test -z "$VITE_COMMONINDEX_TOKEN" && npx vite build

# The stable line, not a single release: each rebuild picks up its security
# fixes (nginx.org/en/security_advisories.html).
FROM nginx:1.30-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /web/dist /usr/share/nginx/html
EXPOSE 80
