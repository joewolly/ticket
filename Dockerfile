# The app has no npm dependencies, so there is nothing to install or build —
# the image is the Node runtime plus the source.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/homelab.db

WORKDIR /app

COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY docs/third-party-notices.md docs/lucide-LICENSE.txt ./licenses/

# The database lives on a mounted volume owned by the unprivileged node user.
RUN mkdir -p /data /backups && chown -R node:node /data /backups /app
USER node

VOLUME ["/data"]
EXPOSE 8080

# Any HTTP response means the server is up and routing, so a 401 counts as
# healthy. Requiring r.ok here marked every password-protected instance —
# which is to say every correctly configured one — permanently unhealthy.
# Set PUBLIC_HEALTH=true if an external monitor needs the body as well.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "src/server.js"]
