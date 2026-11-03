FROM node:22-slim

WORKDIR /app

# Сначала только манифесты — слой с зависимостями кэшируется
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Затем код
COPY . .

ENV NODE_ENV=production

CMD ["node", "index.js"]
