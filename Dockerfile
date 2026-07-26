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

# The database lives on a mounted volume owned by the unprivileged node user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "src/server.js"]
