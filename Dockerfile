FROM node:20-alpine

RUN apk add --no-cache tzdata
ENV TZ=Asia/Tokyo
ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

USER node

EXPOSE 3000

CMD ["node", "server.js"]
