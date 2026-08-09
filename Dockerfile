FROM mcr.microsoft.com/playwright:v1.50.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3080
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

VOLUME ["/data"]
EXPOSE 3080

CMD ["node", "dist/index.js"]
